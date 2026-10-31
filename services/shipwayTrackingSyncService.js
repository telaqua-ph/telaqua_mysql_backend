/**
 * Shipway tracking: read-only status polling for shipments booked through Shipway.
 *
 * - Processes only provider = 'Shipway' rows; Delhivery shipments are never touched.
 * - Calls only GET /api/getorders (via getShipwayTracking); never /api/v2orders.
 * - An API failure only records last_error; status, AWB, carrier and history are never removed.
 */

import crypto from "node:crypto";
import { pool } from "../config/db.js";
import { canAdvanceFulfillment } from "./logisticsState.js";
import { isShipwayShipment } from "./shipmentProvider.js";
import { triggerShipmentTrackingWhatsAppAsync } from "./shipmentTrackingNotificationService.js";
import { findShipwayOrder, getShipwayTracking, isHttpUrl, isShipwayPlaceholderStatus, safeShipwayTrackingError } from "./shipwayService.js";

const DEFAULT_MINUTES = 30;
const MIN_MINUTES = 5;
const DEFAULT_BATCH = 25;
const MAX_BATCH = 100;
const DEFAULT_PACE_MS = 1000;
const MAX_PACE_MS = 10_000;
const EVENT_SOURCE = "shipway_tracking";

const SHIPWAY_ONLY_SQL = "LOWER(TRIM(s.provider)) = 'shipway'";

let timer = null;
let startupTimer = null;
let running = false;
let pendingTimer = null;
let pendingRunning = false;

const DEFAULT_PENDING_MINUTES = 5;

const asJson = (value) => (value == null ? null : JSON.stringify(value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isShipwayTrackingSyncEnabled(env = process.env) {
  return String(env.SHIPWAY_TRACKING_SYNC_ENABLED || "").trim().toLowerCase() === "true";
}

export function shipwayTrackingSyncSettings(env = process.env) {
  const minutes = Number(env.SHIPWAY_TRACKING_SYNC_MINUTES);
  const batch = Number(env.SHIPWAY_TRACKING_SYNC_BATCH);
  const pace = Number(env.SHIPWAY_TRACKING_SYNC_PACE_MS);
  return {
    minutes: Number.isFinite(minutes) && minutes > 0 ? Math.max(MIN_MINUTES, Math.floor(minutes)) : DEFAULT_MINUTES,
    batch: Number.isFinite(batch) && batch > 0 ? Math.min(MAX_BATCH, Math.floor(batch)) : DEFAULT_BATCH,
    paceMs: Number.isFinite(pace) && pace >= 0 ? Math.min(MAX_PACE_MS, Math.floor(pace)) : DEFAULT_PACE_MS,
  };
}

/** Deterministic per-shipment key: the same Shipway scan always hashes to the same key. */
export function shipwayEventKey(event) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([
      "shipway",
      event.statusCode || null,
      event.status || null,
      event.eventTime || null,
      event.location || null,
      event.activity || null,
    ]))
    .digest("hex");
}

function trackingFailure(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

async function orderNumberFor(shipment, db) {
  if (shipment.shipway_order_number) return String(shipment.shipway_order_number);
  const { rows } = await db.query("SELECT id, order_number FROM orders WHERE id = ? LIMIT 1", [shipment.order_id]);
  const order = rows[0];
  // Same identifier the booking flow sends to Shipway as order_id.
  return order ? String(order.order_number || order.id) : null;
}

/**
 * Fetch Shipway tracking for one Shipway shipment and persist it.
 * Stale events (older than the stored shipment_status_at) never replace the current state;
 * the guard is enforced in SQL so a concurrent newer update cannot be overwritten.
 */
export async function refreshShipwayShipment(shipment, { db = pool, actorId = null, fetchTracking = getShipwayTracking } = {}) {
  if (!isShipwayShipment(shipment)) {
    throw trackingFailure("SHIPWAY_TRACKING_NOT_SHIPWAY", "Only Shipway shipments can be tracked through Shipway.", { httpStatus: 409, retryable: false });
  }
  if (!shipment.waybill_number) {
    throw trackingFailure("SHIPWAY_TRACKING_NO_AWB", "This Shipway shipment has no AWB yet. Reconcile the booking before refreshing tracking.", { httpStatus: 409, retryable: false });
  }
  const orderNumber = await orderNumberFor(shipment, db);
  const result = await fetchTracking({ orderNumber, awb: shipment.waybill_number });
  if (result?.state !== "found") {
    throw trackingFailure("SHIPWAY_TRACKING_NOT_FOUND", "Shipway has no tracking for this order yet.", { httpStatus: result?.httpStatus ?? null, retryable: true });
  }
  const tracking = result.tracking;

  let eventsAdded = 0;
  for (const event of tracking.events) {
    const inserted = await db.query(
      `INSERT IGNORE INTO shipment_tracking_history (
         shipment_id, event_key, event_source, status, status_code,
         fulfillment_status, location, instructions, event_time, raw_event
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shipment.id,
        shipwayEventKey(event),
        EVENT_SOURCE,
        event.status,
        event.statusCode,
        event.fulfillmentStatus,
        event.location,
        event.activity,
        event.eventTime,
        asJson(event.raw),
      ]
    );
    eventsAdded += inserted.rowCount || 0;
  }

  const awbMismatch = Boolean(tracking.awb && String(tracking.awb).trim() !== String(shipment.waybill_number).trim());
  if (awbMismatch) {
    console.warn("Shipway tracking: AWB differs from stored AWB; stored AWB kept", { shipmentId: shipment.id });
  }

  const current = String(shipment.fulfillment_status || "unfulfilled").toLowerCase();
  const mapped = tracking.fulfillmentStatus;
  const progressionAllowed = !mapped || canAdvanceFulfillment(current, mapped);
  const next = mapped && progressionAllowed ? mapped : current;
  const hasStatus = Boolean(tracking.statusCode || tracking.statusLabel);
  let applied = false;

  if (hasStatus && progressionAllowed) {
    const delivered = next === "delivered" ? 1 : 0;
    // AWB and provider are never written here; empty carrier values keep the stored ones.
    const updated = await db.query(
      `UPDATE shipments SET fulfillment_status = ?, shipment_status = ?, shipment_status_code = ?,
         shipment_status_at = COALESCE(CAST(? AS DATETIME), shipment_status_at),
         current_location = COALESCE(?, current_location),
         courier_name = COALESCE(?, courier_name), carrier_id = COALESCE(?, carrier_id),
         expected_delivery_date = COALESCE(?, expected_delivery_date),
         delivered_at = CASE WHEN ? = 1 THEN COALESCE(delivered_at, CAST(? AS DATETIME), NOW()) ELSE delivered_at END,
         tracking_response = ?, last_tracking_update = NOW(), last_error = NULL
       WHERE id = ? AND LOWER(TRIM(provider)) = 'shipway'
         AND (shipment_status_at IS NULL OR shipment_status_at <= CAST(? AS DATETIME))`,
      [
        next,
        tracking.statusLabel || tracking.statusCode,
        tracking.statusCode,
        tracking.statusAt,
        tracking.location,
        tracking.carrierName,
        tracking.carrierId,
        tracking.expectedDeliveryDate,
        delivered,
        tracking.statusAt,
        asJson(result.body ?? null),
        shipment.id,
        tracking.statusAt,
      ]
    );
    applied = updated.rowCount === 1;
  }

  if (applied) {
    if (next !== current) {
      await db.query("UPDATE orders SET fulfillment_status = ? WHERE id = ?", [next, shipment.order_id]);
      await db.query(
        "INSERT INTO shipment_audit_log (shipment_id, admin_id, action, before_data, after_data) VALUES (?, ?, ?, ?, ?)",
        [shipment.id, actorId || null, "shipway_tracking_refreshed", asJson({ fulfillment_status: current }), asJson({ fulfillment_status: next, status_code: tracking.statusCode })]
      );
    }
  } else {
    // Stale or non-advancing event: keep the newer stored state, only mark that we checked.
    await db.query("UPDATE shipments SET last_tracking_update = NOW(), last_error = NULL WHERE id = ?", [shipment.id]);
    // A placeholder saved earlier (Shipway "O" / "0") is not a real stage: clear it so
    // the admin shows the stage from the fulfillment status until a courier scan arrives.
    if (isShipwayPlaceholderStatus(shipment.shipment_status)) {
      await db.query(
        "UPDATE shipments SET shipment_status = NULL, shipment_status_code = NULL WHERE id = ? AND LOWER(TRIM(provider)) = 'shipway'",
        [shipment.id]
      );
    }
  }

  return {
    status: applied ? tracking.statusLabel || tracking.statusCode : shipment.shipment_status,
    status_code: applied ? tracking.statusCode : shipment.shipment_status_code,
    fulfillment_status: applied ? next : current,
    events_added: eventsAdded,
    applied,
    stale_ignored: hasStatus && !applied,
    awb_mismatch: awbMismatch,
  };
}

/** Record a failure without touching status, AWB, carrier or tracking history. */
export async function recordShipwayTrackingFailure(shipmentId, error, { db = pool, deferRetry = true } = {}) {
  const message = String(error?.message || "Shipway tracking failed").slice(0, 2000);
  const sql = deferRetry
    ? "UPDATE shipments SET last_error = ?, last_error_at = NOW(), last_tracking_update = NOW() WHERE id = ?"
    : "UPDATE shipments SET last_error = ?, last_error_at = NOW() WHERE id = ?";
  await db.query(sql, [message, shipmentId]).catch(() => {});
}

/**
 * One polling pass. Overlapping calls return immediately; one shipment failing
 * never stops the batch, except account-wide failures (auth/config/429) which pause it.
 */
export async function runShipwayTrackingSync({ db = pool, fetchTracking = getShipwayTracking, env = process.env, sleepFn = sleep } = {}) {
  if (running) return { skipped: true, reason: "already_running" };
  running = true;
  const summary = { skipped: false, attempted: 0, updated: 0, failed: 0, stopped: null };
  try {
    const { batch, paceMs } = shipwayTrackingSyncSettings(env);
    const { rows } = await db.query(
      `SELECT s.*, o.order_number AS shipway_order_number
       FROM shipments s
       JOIN orders o ON o.id = s.order_id
       WHERE ${SHIPWAY_ONLY_SQL}
         AND s.waybill_number IS NOT NULL
         AND s.fulfillment_status COLLATE utf8mb4_unicode_ci NOT IN (
           'delivered' COLLATE utf8mb4_unicode_ci,
           'cancelled' COLLATE utf8mb4_unicode_ci,
           'returned' COLLATE utf8mb4_unicode_ci
         )
         AND (s.last_tracking_update IS NULL OR s.last_tracking_update < DATE_SUB(NOW(), INTERVAL 10 MINUTE))
       ORDER BY COALESCE(s.last_tracking_update, s.created_at) ASC
       LIMIT ${batch}`
    );
    // Defence in depth: the SQL filter is repeated in code so a Delhivery row can never be processed.
    const shipments = rows.filter(isShipwayShipment);
    for (let i = 0; i < shipments.length; i += 1) {
      const shipment = shipments[i];
      summary.attempted += 1;
      try {
        const result = await refreshShipwayShipment(shipment, { db, fetchTracking });
        if (result.applied) summary.updated += 1;
      } catch (error) {
        summary.failed += 1;
        const safe = safeShipwayTrackingError(error);
        if (error?.stopBatch) {
          await recordShipwayTrackingFailure(shipment.id, error, { db, deferRetry: false });
          console.warn("Scheduled Shipway tracking paused for this run", { shipmentId: shipment.id, ...safe });
          summary.stopped = safe.code;
          break;
        }
        await recordShipwayTrackingFailure(shipment.id, error, { db });
        console.warn("Scheduled Shipway tracking failed for shipment", { shipmentId: shipment.id, ...safe });
      }
      if (i < shipments.length - 1 && paceMs > 0) await sleepFn(paceMs);
    }
    if (summary.attempted) console.log("Scheduled Shipway tracking processed", { ...summary });
  } catch (error) {
    console.error("Scheduled Shipway tracking sync failed", { code: error?.code || null });
    summary.error = error?.code || "SYNC_FAILED";
  } finally {
    running = false;
  }
  return summary;
}

/**
 * Pending-AWB pass (read-only toward Shipway: GET getorders only, never v2orders).
 * A Shipway shipment without an AWB (e.g. "Booking Failed" because the first courier
 * refused the pincode) is looked up again. When the admin has assigned/re-assigned a
 * courier in Shipway, the AWB, courier and label are saved and the order becomes
 * Ready to Ship, so the admin dashboard stops showing "Booking Failed".
 */
export async function runShipwayPendingAwbSync({ db = pool, lookup = findShipwayOrder, env = process.env, sleepFn = sleep, notifyShipped = triggerShipmentTrackingWhatsAppAsync } = {}) {
  if (pendingRunning) return { skipped: true, reason: "already_running" };
  pendingRunning = true;
  const summary = { skipped: false, checked: 0, saved: 0, failed: 0 };
  try {
    const { batch, paceMs } = shipwayTrackingSyncSettings(env);
    const { rows } = await db.query(
      `SELECT s.*, o.order_number AS shipway_order_number
       FROM shipments s
       JOIN orders o ON o.id = s.order_id
       WHERE ${SHIPWAY_ONLY_SQL}
         AND s.waybill_number IS NULL
         AND (s.processing_token IS NULL OR s.processing_started_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE))
         AND COALESCE(s.fulfillment_status, 'unfulfilled') COLLATE utf8mb4_unicode_ci NOT IN (
           'delivered' COLLATE utf8mb4_unicode_ci,
           'cancelled' COLLATE utf8mb4_unicode_ci,
           'returned' COLLATE utf8mb4_unicode_ci
         )
         AND s.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
         AND (s.last_tracking_update IS NULL OR s.last_tracking_update < DATE_SUB(NOW(), INTERVAL 5 MINUTE))
       ORDER BY COALESCE(s.last_tracking_update, s.created_at) ASC
       LIMIT ${batch}`
    );
    const shipments = rows.filter(isShipwayShipment);
    for (let i = 0; i < shipments.length; i += 1) {
      const shipment = shipments[i];
      summary.checked += 1;
      try {
        const orderNumber = await orderNumberFor(shipment, db);
        const found = orderNumber ? await lookup(orderNumber, { timeoutMs: 10_000 }) : null;
        const awb = found?.state === "exists" ? String(found.awb || "").trim() : "";
        if (awb) {
          const labelUrl = isHttpUrl(found.labelUrl) ? found.labelUrl : null;
          const saved = await db.query(
            `UPDATE shipments SET provider = 'Shipway', waybill_number = ?,
               courier_name = COALESCE(?, courier_name, 'Shipway'), carrier_id = COALESCE(?, carrier_id),
               fulfillment_status = 'ready_to_ship', shipment_status = 'Ready to Ship',
               shipment_created_at = COALESCE(shipment_created_at, NOW()),
               shipping_label_url = COALESCE(?, shipping_label_url),
               label_status = CASE WHEN ? IS NULL THEN label_status ELSE 'Generated' END,
               label_generated_at = CASE WHEN ? IS NULL THEN label_generated_at ELSE COALESCE(label_generated_at, NOW()) END,
               shipment_response = ?, processing_token = NULL, processing_started_at = NULL,
               last_error = NULL, last_tracking_update = NOW()
             WHERE id = ? AND waybill_number IS NULL AND LOWER(TRIM(provider)) = 'shipway'
               AND (processing_token IS NULL OR processing_started_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE))`,
            [awb, found.carrierName || null, found.carrierId || null, labelUrl, labelUrl, labelUrl, asJson(found.body ?? null), shipment.id]
          );
          if (saved.rowCount === 1) {
            summary.saved += 1;
            await db.query("UPDATE orders SET fulfillment_status = 'ready_to_ship' WHERE id = ?", [shipment.order_id]);
            await db.query(
              "INSERT INTO shipment_audit_log (shipment_id, admin_id, action, before_data, after_data) VALUES (?, ?, ?, ?, ?)",
              [shipment.id, null, "shipway_awb_synced", asJson({ shipment_status: shipment.shipment_status || null }), asJson({ waybill: awb, carrierName: found.carrierName || null, labelUrl })]
            );
            console.log("Shipway AWB synced for pending shipment", { shipmentId: shipment.id, orderNumber });
            // Customer gets the shipped + tracking-link WhatsApp once (never blocks the sync).
            notifyShipped(shipment.id);
          }
        } else {
          // No courier assigned yet in Shipway: check again on a later run.
          await db.query("UPDATE shipments SET last_tracking_update = NOW() WHERE id = ? AND waybill_number IS NULL", [shipment.id]);
        }
      } catch (error) {
        summary.failed += 1;
        await db.query("UPDATE shipments SET last_tracking_update = NOW() WHERE id = ? AND waybill_number IS NULL", [shipment.id]).catch(() => {});
        console.warn("Shipway pending AWB check failed", { shipmentId: shipment.id, message: String(error?.message || "").slice(0, 200) });
      }
      if (i < shipments.length - 1 && paceMs > 0) await sleepFn(paceMs);
    }
    if (summary.checked) console.log("Shipway pending AWB sync processed", { ...summary });
  } catch (error) {
    console.error("Shipway pending AWB sync failed", { code: error?.code || null, message: String(error?.message || "").slice(0, 200) });
    summary.error = error?.code || "SYNC_FAILED";
  } finally {
    pendingRunning = false;
  }
  return summary;
}

export function startShipwayTrackingSync(env = process.env) {
  if (!isShipwayTrackingSyncEnabled(env)) return null;
  if (timer) return timer;
  const { minutes } = shipwayTrackingSyncSettings(env);
  timer = setInterval(() => { runShipwayTrackingSync(); }, minutes * 60 * 1000);
  timer.unref?.();
  startupTimer = setTimeout(() => { runShipwayTrackingSync(); }, 15_000);
  startupTimer.unref?.();
  const pendingMinutes = Number(env.SHIPWAY_PENDING_AWB_SYNC_MINUTES);
  const everyMinutes = Number.isFinite(pendingMinutes) && pendingMinutes > 0 ? Math.max(2, Math.floor(pendingMinutes)) : DEFAULT_PENDING_MINUTES;
  pendingTimer = setInterval(() => { runShipwayPendingAwbSync(); }, everyMinutes * 60 * 1000);
  pendingTimer.unref?.();
  console.log("Shipway tracking sync started", { minutes, pendingAwbMinutes: everyMinutes });
  return timer;
}

export function stopShipwayTrackingSync() {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  if (pendingTimer) clearInterval(pendingTimer);
  timer = null;
  startupTimer = null;
  pendingTimer = null;
}
