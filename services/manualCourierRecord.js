/**
 * services/manualCourierRecord.js
 *
 * Record the courier + article/AWB number for an order that was booked OUTSIDE
 * the admin (e.g. directly in the India Post portal or at the post office counter).
 *
 * Unlike "Book with India Post", this:
 *  - works for India Post, Shipway and Delhivery,
 *  - never calls the courier's API,
 *  - keeps the order's current delivery status when it is already further along
 *    (an order already marked Delivered stays Delivered),
 *  - only messages the customer when asked to (notify = true).
 *
 * The number is saved in shipments.waybill_number with the right provider, so the
 * Orders list, AWB, tracking link and the courier's tracking sync all work as normal.
 */
import { pool } from "../config/db.js";
import { getDelhiveryEnvironment } from "../config/delhiveryConfig.js";
import { INDIA_POST_COURIER_NAME, INDIA_POST_PROVIDER } from "./indiaPostService.js";
import { triggerShipmentTrackingWhatsAppAsync } from "./shipmentTrackingNotificationService.js";

const ARTICLE_NUMBER = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
const AWB_NUMBER = /^[A-Z0-9-]{6,40}$/;
const LOCK_GRACE_MS = 2 * 60 * 1000;

/** Statuses that mean "not yet handed to a courier". Anything else is kept as it is. */
const EARLY_STATUSES = new Set([
  "", "unfulfilled", "pending", "pending_awb", "awb_pending", "not_created",
  "shipment_created", "ready_to_ship", "booking_failed", "failed",
]);

/** Statuses after which the customer should not get a "shipped" WhatsApp. */
const FINISHED_STATUSES = new Set(["delivered", "returned", "rto", "rto_delivered", "cancelled", "lost"]);

export const COURIER_OPTIONS = {
  indiapost: { provider: INDIA_POST_PROVIDER, defaultName: INDIA_POST_COURIER_NAME, label: "India Post" },
  shipway: { provider: "Shipway", defaultName: "Shipway", label: "Shipway" },
  delhivery: { provider: "Delhivery", defaultName: "Delhivery", label: "Delhivery" },
};

function recordError(message, httpStatus = 409) {
  return Object.assign(new Error(message), { httpStatus, publicMessage: message });
}

export function normalizeCourierKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
}

export function normalizeTrackingNumber(value) {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase();
}

/** Validate the form input. Returns { option, number, courierName } or throws a 422 error. */
export function validateCourierInput({ courier, number, courierName }) {
  const option = COURIER_OPTIONS[normalizeCourierKey(courier)];
  if (!option) throw recordError("Choose the courier: India Post, Shipway or Delhivery.", 422);
  const clean = normalizeTrackingNumber(number);
  if (option.provider === INDIA_POST_PROVIDER) {
    if (!ARTICLE_NUMBER.test(clean)) throw recordError("Enter the India Post article number from the receipt, e.g. EN123456789IN.", 422);
  } else if (!AWB_NUMBER.test(clean)) {
    throw recordError("Enter a valid AWB number (letters and digits only, at least 6 characters).", 422);
  }
  const name = String(courierName ?? "").trim().slice(0, 100);
  return { option, number: clean, courierName: name || option.defaultName };
}

/** Keep the delivery status unless the order has not been shipped yet. */
export function statusAfterRecording(currentStatus) {
  const current = String(currentStatus ?? "").trim().toLowerCase();
  return EARLY_STATUSES.has(current) ? "ready_to_ship" : current;
}

export function shipmentStatusLabel(status) {
  if (status === "ready_to_ship") return "Booked";
  return String(status || "").split("_").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || "Booked";
}

export function shouldNotifyCustomer(notify, status) {
  return notify === true && !FINISHED_STATUSES.has(String(status || "").toLowerCase());
}

/**
 * Save the courier for one order.
 * @param {number} orderId
 * @param {{ courier: string, number: string, courierName?: string, notify?: boolean, actorId?: number }} input
 */
export async function recordCourierForOrder(orderId, input, { db = pool, notifyFn = triggerShipmentTrackingWhatsAppAsync } = {}) {
  const { option, number, courierName } = validateCourierInput(input);
  const actorId = input.actorId || null;

  const client = await db.connect();
  let shipmentId;
  let newStatus;
  try {
    await client.query("BEGIN");
    const order = (await client.query("SELECT * FROM orders WHERE id = ? LIMIT 1 FOR UPDATE", [orderId])).rows[0];
    if (!order) throw recordError("Order not found.", 404);
    if (String(order.order_status || order.status || "").trim().toLowerCase() === "cancelled") {
      throw recordError("This order is cancelled. A courier cannot be recorded for it.");
    }

    const duplicate = (await client.query(
      "SELECT order_id FROM shipments WHERE waybill_number = ? AND order_id <> ? LIMIT 1",
      [number, orderId]
    )).rows[0];
    if (duplicate) throw recordError(`${number} is already saved on another order (order id ${duplicate.order_id}). Check the number.`);

    let shipment = (await client.query(
      "SELECT * FROM shipments WHERE order_id = ? AND sequence_no = 1 LIMIT 1 FOR UPDATE",
      [orderId]
    )).rows[0];
    if (!shipment) {
      const inserted = await client.query(
        `INSERT INTO shipments (order_id, sequence_no, idempotency_key, environment, fulfillment_status)
         VALUES (?, 1, ?, ?, 'unfulfilled')`,
        [orderId, `order:${orderId}:shipment:1`, getDelhiveryEnvironment()]
      );
      shipment = (await client.query("SELECT * FROM shipments WHERE id = ? LIMIT 1 FOR UPDATE", [inserted.insertId])).rows[0];
    }
    if (shipment.waybill_number || order.waybill) {
      throw recordError(`This order already has ${shipment.courier_name || shipment.provider || "a courier"} ${shipment.waybill_number || order.waybill}. It was not changed.`);
    }
    if (shipment.processing_token && Date.now() - new Date(shipment.processing_started_at || 0).getTime() < LOCK_GRACE_MS) {
      throw recordError("A shipment is being created for this order right now. Wait a minute, then refresh.");
    }

    newStatus = statusAfterRecording(order.fulfillment_status);
    await client.query(
      `UPDATE shipments
         SET provider = ?, courier_name = ?, waybill_number = ?, fulfillment_status = ?, shipment_status = ?,
             shipment_created_at = COALESCE(shipment_created_at, NOW()), shipment_response = ?,
             processing_token = NULL, processing_started_at = NULL, last_error = NULL
       WHERE id = ?`,
      [option.provider, courierName, number, newStatus, shipmentStatusLabel(newStatus),
        JSON.stringify({ source: "manual_courier_record", entered_by: actorId }), shipment.id]
    );
    if (String(order.fulfillment_status || "").toLowerCase() !== newStatus) {
      await client.query("UPDATE orders SET fulfillment_status = ? WHERE id = ?", [newStatus, orderId]);
    }
    await client.query("COMMIT");
    shipmentId = shipment.id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await db.query(
    "INSERT INTO shipment_audit_log (shipment_id, admin_id, action, before_data, after_data) VALUES (?, ?, ?, ?, ?)",
    [shipmentId, actorId, "courier_recorded_manually", null, JSON.stringify({ provider: option.provider, courier_name: courierName, waybill: number, fulfillment_status: newStatus })]
  ).catch((error) => console.warn("Courier record audit failed", { message: error?.message }));

  const notified = shouldNotifyCustomer(input.notify, newStatus);
  if (notified) notifyFn(shipmentId);

  return { shipmentId, provider: option.provider, courierName, waybill: number, fulfillmentStatus: newStatus, notified };
}
