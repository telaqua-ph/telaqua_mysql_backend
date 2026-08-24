import crypto from "node:crypto";

import {
  canAdvanceFulfillment,
  mapDelhiveryStatus,
} from "./logisticsState.js";

function clean(value, maxLength = 255) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function webhookError(code, message) {
  return Object.assign(new Error(message), { code });
}

function mysqlDateTime(value) {
  const text = String(value || "").trim();
  const naive = text.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/
  );
  if (naive) return `${naive[1]} ${naive[2]}`;

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

function comparableTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const normalized = String(value).trim().replace(" ", "T");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

export function parseDelhiveryScanPush(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw webhookError("DELHIVERY_WEBHOOK_INVALID_PAYLOAD", "Payload must be a JSON object.");
  }

  const shipment = payload.Shipment;
  const statusBlock = shipment?.Status;
  if (!shipment || typeof shipment !== "object" || !statusBlock || typeof statusBlock !== "object") {
    throw webhookError(
      "DELHIVERY_WEBHOOK_INVALID_PAYLOAD",
      "Payload must contain Shipment.Status."
    );
  }

  const awb = clean(shipment.AWB, 40);
  const status = clean(statusBlock.Status, 160);
  const statusType = clean(statusBlock.StatusType, 16).toUpperCase();
  const statusDateTime = mysqlDateTime(statusBlock.StatusDateTime);

  if (!/^\d{8,20}$/.test(awb)) {
    throw webhookError("DELHIVERY_WEBHOOK_INVALID_PAYLOAD", "Shipment.AWB is invalid.");
  }
  if (!status) {
    throw webhookError("DELHIVERY_WEBHOOK_INVALID_PAYLOAD", "Shipment.Status.Status is required.");
  }
  if (!statusType) {
    throw webhookError("DELHIVERY_WEBHOOK_INVALID_PAYLOAD", "Shipment.Status.StatusType is required.");
  }
  if (!statusDateTime) {
    throw webhookError(
      "DELHIVERY_WEBHOOK_INVALID_PAYLOAD",
      "Shipment.Status.StatusDateTime is invalid."
    );
  }

  const event = {
    awb,
    status,
    statusType,
    statusDateTime,
    location: clean(statusBlock.StatusLocation, 255) || null,
    instructions: clean(statusBlock.Instructions, 2000) || null,
    nslCode: clean(shipment.NSLCode, 60) || null,
    referenceNo: clean(shipment.ReferenceNo, 160) || null,
    pickupDate: mysqlDateTime(shipment.PickUpDate),
    sortcode: clean(shipment.Sortcode, 80) || null,
    raw: payload,
  };

  event.fulfillmentStatus = mapDelhiveryStatus(
    event.status,
    `${event.statusType} ${event.nslCode || ""}`
  );
  event.eventKey = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        event.awb,
        event.status,
        event.statusType,
        event.statusDateTime,
        event.location,
        event.instructions,
        event.nslCode,
      ])
    )
    .digest("hex");

  return event;
}

export function isStatusEventCurrent(currentStatusAt, incomingStatusAt) {
  const current = comparableTime(currentStatusAt);
  const incoming = comparableTime(incomingStatusAt);
  if (incoming === null) return false;
  return current === null || incoming >= current;
}

export async function persistDelhiveryScanPush(event, databasePool) {
  if (!databasePool?.connect) {
    throw webhookError("DELHIVERY_WEBHOOK_DB_UNAVAILABLE", "Database pool is unavailable.");
  }
  const client = await databasePool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM shipments WHERE waybill_number = ? LIMIT 1 FOR UPDATE",
      [event.awb]
    );
    const shipment = rows[0];
    if (!shipment) {
      throw webhookError(
        "DELHIVERY_WEBHOOK_SHIPMENT_NOT_FOUND",
        "No shipment exists for this AWB."
      );
    }

    const statusCode = [event.statusType, event.nslCode].filter(Boolean).join(":").slice(0, 60);
    const inserted = await client.query(
      `INSERT IGNORE INTO shipment_tracking_history (
         shipment_id, event_key, event_source, status, status_code,
         fulfillment_status, location, instructions, event_time, raw_event
       ) VALUES (?, ?, 'delhivery_webhook', ?, ?, ?, ?, ?, ?, ?)`,
      [
        shipment.id,
        event.eventKey,
        event.status,
        statusCode || null,
        event.fulfillmentStatus,
        event.location,
        event.instructions,
        event.statusDateTime,
        JSON.stringify(event.raw),
      ]
    );

    if (inserted.rowCount === 0) {
      await client.query("COMMIT");
      return { shipmentId: shipment.id, orderId: shipment.order_id, duplicate: true, applied: false };
    }

    const currentFulfillment = String(shipment.fulfillment_status || "unfulfilled").toLowerCase();
    const mapped = event.fulfillmentStatus;
    const progressionAllowed = !mapped || canAdvanceFulfillment(currentFulfillment, mapped);
    const currentEvent = isStatusEventCurrent(
      shipment.shipment_status_at,
      event.statusDateTime
    );
    const applied = currentEvent && progressionAllowed;

    if (applied) {
      const nextFulfillment = mapped || currentFulfillment;
      await client.query(
        `UPDATE shipments SET
           fulfillment_status = ?,
           shipment_status = ?,
           shipment_status_code = ?,
           shipment_status_at = ?,
           current_location = COALESCE(?, current_location),
           pickup_status = CASE
             WHEN ? IN ('picked_up','in_transit','out_for_delivery','delivered')
             THEN 'Picked Up' ELSE pickup_status END,
           last_tracking_update = CURRENT_TIMESTAMP,
           delivered_at = CASE
             WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?, CURRENT_TIMESTAMP)
             ELSE delivered_at END,
           ndr_status = CASE WHEN ? = 'ndr' THEN 'open' ELSE ndr_status END,
           ndr_reason = CASE WHEN ? = 'ndr' THEN COALESCE(?, ndr_reason) ELSE ndr_reason END,
           last_error = NULL
         WHERE id = ?`,
        [
          nextFulfillment,
          event.status,
          statusCode || null,
          event.statusDateTime,
          event.location,
          nextFulfillment,
          nextFulfillment,
          event.statusDateTime,
          nextFulfillment,
          nextFulfillment,
          event.instructions,
          shipment.id,
        ]
      );
      await client.query(
        "UPDATE orders SET fulfillment_status = ? WHERE id = ?",
        [nextFulfillment, shipment.order_id]
      );
      await client.query(
        `INSERT INTO shipment_audit_log (
           shipment_id, admin_id, action, before_data, after_data
         ) VALUES (?, NULL, 'webhook_status_received', ?, ?)`,
        [
          shipment.id,
          JSON.stringify({
            fulfillment_status: currentFulfillment,
            shipment_status: shipment.shipment_status,
            shipment_status_at: shipment.shipment_status_at,
          }),
          JSON.stringify({
            fulfillment_status: nextFulfillment,
            shipment_status: event.status,
            shipment_status_at: event.statusDateTime,
            event_key: event.eventKey,
          }),
        ]
      );
    }

    await client.query("COMMIT");
    return {
      shipmentId: shipment.id,
      orderId: shipment.order_id,
      duplicate: false,
      applied,
      stale: !currentEvent,
      regressionBlocked: currentEvent && !progressionAllowed,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
