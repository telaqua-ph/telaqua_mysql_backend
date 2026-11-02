/**
 * India Post shipments for Tel-Aqua orders.
 *
 * - bookOrderWithIndiaPost: books through the India Post API (or records an
 *   article number booked at the post office counter when manual=true).
 * - refreshIndiaPostShipment / runIndiaPostTrackingSync: tracking updates.
 * The article number is stored in shipments.waybill_number with
 * provider = 'IndiaPost', so Orders, AWB, tracking link and the "Dispatched"
 * WhatsApp work exactly like Shipway shipments.
 */
import crypto from "node:crypto";
import { pool } from "../config/db.js";
import { getDelhiveryEnvironment } from "../config/delhiveryConfig.js";
import { canAdvanceFulfillment } from "./logisticsState.js";
import { canFulfillOrder } from "./paymentMode.js";
import {
  INDIA_POST_COURIER_NAME,
  INDIA_POST_PROVIDER,
  bookIndiaPostArticle,
  getIndiaPostTracking,
  isIndiaPostShipment,
  mapIndiaPostStatus,
} from "./indiaPostService.js";
import { triggerShipmentTrackingWhatsAppAsync } from "./shipmentTrackingNotificationService.js";

const asJson = (value) => (value == null ? null : JSON.stringify(value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ARTICLE_NUMBER = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
const LOCK_GRACE_MS = 2 * 60 * 1000;

function shipmentError(message, httpStatus = 409, extra = {}) {
  return Object.assign(new Error(message), { httpStatus, publicMessage: message, ...extra });
}

export function normalizeArticleNumber(value) {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase();
}

async function writeAudit(db, shipmentId, actorId, action, before, after) {
  await db.query(
    "INSERT INTO shipment_audit_log (shipment_id, admin_id, action, before_data, after_data) VALUES (?, ?, ?, ?, ?)",
    [shipmentId, actorId || null, action, asJson(before), asJson(after)]
  ).catch((error) => console.warn("India Post audit write failed", { message: error?.message }));
}

/** Lock the order + its shipment row and claim it for an India Post booking. */
async function claimShipment(orderId, { db, token }) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const order = (await client.query("SELECT * FROM orders WHERE id = ? LIMIT 1 FOR UPDATE", [orderId])).rows[0];
    if (!order) throw shipmentError("Order not found.", 404);
    if (!canFulfillOrder(order)) throw shipmentError("Only paid prepaid orders, or COD orders that are Pending or Paid, can be shipped.");
    let shipment = (await client.query("SELECT * FROM shipments WHERE order_id = ? AND sequence_no = 1 LIMIT 1 FOR UPDATE", [orderId])).rows[0];
    if (!shipment) {
      const inserted = await client.query(
        `INSERT INTO shipments (order_id, sequence_no, idempotency_key, environment, fulfillment_status)
         VALUES (?, 1, ?, ?, 'unfulfilled')`,
        [orderId, `order:${orderId}:shipment:1`, getDelhiveryEnvironment()]
      );
      shipment = (await client.query("SELECT * FROM shipments WHERE id = ? LIMIT 1 FOR UPDATE", [inserted.insertId])).rows[0];
    }
    if (shipment.waybill_number || order.waybill) {
      throw shipmentError(`This order already has a shipment (${shipment.waybill_number || order.waybill}). It was not sent to India Post.`);
    }
    if (shipment.processing_token && Date.now() - new Date(shipment.processing_started_at || 0).getTime() < LOCK_GRACE_MS) {
      throw shipmentError("A shipment is already being created for this order. Wait a minute, then refresh.");
    }
    await client.query(
      `UPDATE shipments SET provider = ?, courier_name = ?, processing_token = ?, processing_started_at = NOW(), last_error = NULL WHERE id = ?`,
      [INDIA_POST_PROVIDER, INDIA_POST_COURIER_NAME, token, shipment.id]
    );
    await client.query("COMMIT");
    return { order, shipment };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Book (or record) an India Post shipment for one order.
 * @param {{ manual?: boolean, barcode?: string, weightGrams?: number, actorId?: number }} options
 */
export async function bookOrderWithIndiaPost(orderId, { manual = false, barcode = "", weightGrams, actorId = null, db = pool, book = bookIndiaPostArticle, notify = triggerShipmentTrackingWhatsAppAsync } = {}) {
  const article = normalizeArticleNumber(barcode);
  if (manual && !ARTICLE_NUMBER.test(article)) throw shipmentError("Enter the India Post article number from the receipt, e.g. EB123456789IN.", 422);
  if (!manual && article && !ARTICLE_NUMBER.test(article)) throw shipmentError("The article number must look like EB123456789IN.", 422);

  const token = `indiapost:${crypto.randomUUID()}`;
  const { order, shipment } = await claimShipment(orderId, { db, token });

  let booking;
  try {
    booking = manual
      ? { barcode: article, tariff: null, raw: { source: "manual", entered_by: actorId } }
      : await book(order, { barcode: article, weightGrams });
  } catch (error) {
    await db.query(
      `UPDATE shipments SET processing_token = NULL, processing_started_at = NULL, shipment_status = 'Booking Failed',
         last_error = ?, last_error_response = ?, last_error_at = NOW()
       WHERE id = ? AND processing_token = ?`,
      [String(error?.message || "India Post booking failed").slice(0, 2000), asJson(error?.upstreamBody || null), shipment.id, token]
    ).catch(() => {});
    await writeAudit(db, shipment.id, actorId, "indiapost_booking_failed", null, { code: error?.code || null, message: String(error?.message || "").slice(0, 300) });
    throw error;
  }

  const saved = await db.query(
    `UPDATE shipments SET provider = ?, courier_name = ?, waybill_number = ?, fulfillment_status = 'ready_to_ship',
       shipment_status = 'Booked', shipment_created_at = COALESCE(shipment_created_at, NOW()), shipping_charge = COALESCE(?, shipping_charge),
       shipment_response = ?, processing_token = NULL, processing_started_at = NULL, last_error = NULL
     WHERE id = ? AND processing_token = ? AND waybill_number IS NULL`,
    [INDIA_POST_PROVIDER, INDIA_POST_COURIER_NAME, booking.barcode, booking.tariff, asJson(booking.raw), shipment.id, token]
  );
  if ((saved.rowCount ?? saved.affectedRows ?? 0) !== 1) {
    throw shipmentError(`India Post booked article ${booking.barcode}, but it could not be saved because the shipment changed. Do not book again; refresh the order and contact support.`, 409, { barcode: booking.barcode });
  }
  await db.query("UPDATE orders SET fulfillment_status = 'ready_to_ship' WHERE id = ?", [order.id]);
  await writeAudit(db, shipment.id, actorId, manual ? "indiapost_manual_recorded" : "indiapost_booked", null, { barcode: booking.barcode, tariff: booking.tariff, batchId: booking.batchId || null });
  notify(shipment.id);
  return { shipmentId: shipment.id, barcode: booking.barcode, tariff: booking.tariff, manual };
}

const eventKey = (event) => crypto.createHash("sha256")
  .update(`${event.eventTime || ""}|${event.status}|${event.location || ""}`).digest("hex").slice(0, 64);

/** Pull India Post tracking for one shipment and store new events + the latest status. */
export async function refreshIndiaPostShipment(shipment, { db = pool, fetchTracking = getIndiaPostTracking } = {}) {
  if (!isIndiaPostShipment(shipment)) throw shipmentError("This order is not shipped through India Post.");
  if (!shipment.waybill_number) throw shipmentError("This India Post shipment has no article number yet.");
  const tracking = await fetchTracking(shipment.waybill_number);
  if (!tracking) {
    await db.query("UPDATE shipments SET last_tracking_update = NOW() WHERE id = ?", [shipment.id]);
    return { applied: false, status: shipment.shipment_status, not_found: true, events_added: 0 };
  }

  let eventsAdded = 0;
  for (const event of tracking.history) {
    const inserted = await db.query(
      `INSERT IGNORE INTO shipment_tracking_history (
         shipment_id, event_key, event_source, status, status_code,
         fulfillment_status, location, instructions, event_time, raw_event
       ) VALUES (?, ?, 'indiapost', ?, NULL, ?, ?, NULL, ?, ?)`,
      [shipment.id, eventKey(event), event.status.slice(0, 255), mapIndiaPostStatus(event.status), event.location,
        event.eventTime ? new Date(event.eventTime) : null, asJson(event.raw)]
    );
    eventsAdded += inserted.rowCount ?? inserted.affectedRows ?? 0;
  }

  const current = String(shipment.fulfillment_status || "unfulfilled").toLowerCase();
  const mapped = tracking.fulfillmentStatus;
  const next = mapped && canAdvanceFulfillment(current, mapped) ? mapped : current;
  const delivered = next === "delivered" ? 1 : 0;
  await db.query(
    `UPDATE shipments SET fulfillment_status = ?, shipment_status = COALESCE(?, shipment_status),
       current_location = COALESCE(?, current_location), expected_delivery_date = COALESCE(?, expected_delivery_date),
       delivered_at = CASE WHEN ? = 1 THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
       tracking_response = ?, last_tracking_update = NOW(), last_error = NULL
     WHERE id = ?`,
    [next, tracking.currentStatus || null, tracking.location, tracking.estimatedDelivery || null, delivered, asJson(tracking.raw), shipment.id]
  );
  if (next !== current) {
    await db.query("UPDATE orders SET fulfillment_status = ? WHERE id = ?", [next, shipment.order_id]);
  }
  return { applied: true, status: tracking.currentStatus, fulfillment_status: next, events_added: eventsAdded };
}

let running = false;
let timer = null;
let startupTimer = null;

export function indiaPostTrackingSyncSettings(env = process.env) {
  const minutes = Number(env.INDIA_POST_TRACKING_SYNC_MINUTES);
  const pace = Number(env.INDIA_POST_TRACKING_SYNC_PACE_MS);
  return {
    enabled: Boolean(String(env.INDIA_POST_USERNAME || "").trim()) && String(env.INDIA_POST_TRACKING_SYNC_ENABLED ?? "true").toLowerCase() !== "false",
    minutes: Number.isFinite(minutes) && minutes >= 15 ? Math.floor(minutes) : 120,
    paceMs: Number.isFinite(pace) && pace >= 0 ? pace : 1000,
  };
}

/** One pass over active India Post shipments. Never overlaps; one failure never stops the batch. */
export async function runIndiaPostTrackingSync({ db = pool, fetchTracking = getIndiaPostTracking, env = process.env, sleepFn = sleep } = {}) {
  if (running) return { skipped: true };
  running = true;
  const summary = { attempted: 0, updated: 0, failed: 0 };
  try {
    const { paceMs } = indiaPostTrackingSyncSettings(env);
    const { rows } = await db.query(
      `SELECT * FROM shipments
       WHERE LOWER(TRIM(provider)) = 'indiapost' AND waybill_number IS NOT NULL
         AND fulfillment_status NOT IN ('delivered', 'cancelled', 'returned')
         AND (last_tracking_update IS NULL OR last_tracking_update < DATE_SUB(NOW(), INTERVAL 30 MINUTE))
       ORDER BY COALESCE(last_tracking_update, created_at) ASC
       LIMIT 50`
    );
    const shipments = rows.filter(isIndiaPostShipment);
    for (let i = 0; i < shipments.length; i += 1) {
      summary.attempted += 1;
      try {
        const result = await refreshIndiaPostShipment(shipments[i], { db, fetchTracking });
        if (result.applied) summary.updated += 1;
      } catch (error) {
        summary.failed += 1;
        await db.query("UPDATE shipments SET last_error = ?, last_error_at = NOW(), last_tracking_update = NOW() WHERE id = ?",
          [String(error?.message || "India Post tracking failed").slice(0, 2000), shipments[i].id]).catch(() => {});
        if (["INDIA_POST_AUTH_FAILED", "INDIA_POST_CONFIG_ERROR", "INDIA_POST_NETWORK_ERROR"].includes(error?.code)) {
          console.warn("India Post tracking paused for this run", { code: error.code });
          break;
        }
      }
      if (i < shipments.length - 1 && paceMs > 0) await sleepFn(paceMs);
    }
    if (summary.attempted) console.log("India Post tracking processed", summary);
  } catch (error) {
    console.error("India Post tracking sync failed", { code: error?.code || null, message: String(error?.message || "").slice(0, 200) });
  } finally {
    running = false;
  }
  return summary;
}

export function startIndiaPostTrackingSync(env = process.env) {
  const { enabled, minutes } = indiaPostTrackingSyncSettings(env);
  if (!enabled || timer) return timer;
  timer = setInterval(() => { runIndiaPostTrackingSync(); }, minutes * 60 * 1000);
  timer.unref?.();
  startupTimer = setTimeout(() => { runIndiaPostTrackingSync(); }, 30_000);
  startupTimer.unref?.();
  console.log("India Post tracking sync started", { minutes });
  return timer;
}

export function stopIndiaPostTrackingSync() {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
}
