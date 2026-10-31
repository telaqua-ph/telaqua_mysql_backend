/**
 * WhatsApp "order shipped" message with the customer's own Shipway tracking link.
 *
 * Sent once per shipment, right after Shipway assigns an AWB (manual Ship Order,
 * late-AWB reconcile, or the background pending-AWB sync). Never blocks or fails
 * shipping: every error is logged and recorded, nothing is thrown to the caller.
 *
 * Interakt template (create + get approved first), default name order_shipped_tracking:
 *   Body:   Hi {{1}}, your Tel-Aqua order {{2}} has been shipped via {{3}}.
 *   Button: URL "Track order" -> https://telaqua.shipway.com/tracking/forward/{{1}}
 *           (button value = AWB; or set INTERAKT_SHIPPED_BUTTON_MODE=url and use {{1}})
 *
 * .env
 *   INTERAKT_SHIPPED_ENABLED=true            (default false until the template is approved)
 *   INTERAKT_SHIPPED_TEMPLATE_NAME=order_shipped_tracking
 *   INTERAKT_SHIPPED_TEMPLATE_LANGUAGE=en
 *   INTERAKT_SHIPPED_BODY_FIELDS=name,order_number,courier   (any of: name, order_number, courier, awb, tracking_url, product)
 *   INTERAKT_SHIPPED_BUTTON_MODE=awb         (awb | url | none)
 *   SHIPWAY_TRACKING_BASE_URL=https://telaqua.shipway.com/tracking/forward/
 */
import { pool } from "../config/db.js";
import { isDuplicateKeyError, isMissingColumnError } from "../lib/dbErrors.js";
import { sendInteraktTemplate } from "./interaktService.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";

export const DEFAULT_SHIPWAY_TRACKING_BASE = "https://telaqua.shipway.com/tracking/forward/";
const DEFAULT_TEMPLATE_NAME = "order_shipped_tracking";
const DEFAULT_BODY_FIELDS = "name,order_number,courier";
const DEFAULT_PRODUCT_NAME = "Tel-Aqua pH Meter";

/** Public Shipway tracking page for an AWB, e.g. https://telaqua.shipway.com/tracking/forward/SMMC1003902898/ */
export function shipwayTrackingUrl(awb, base = process.env.SHIPWAY_TRACKING_BASE_URL) {
  const value = String(awb || "").trim();
  if (!value) return null;
  let root = String(base || "").trim() || DEFAULT_SHIPWAY_TRACKING_BASE;
  if (!/^https?:\/\//i.test(root)) root = DEFAULT_SHIPWAY_TRACKING_BASE;
  return `${root.replace(/\/+$/, "")}/${encodeURIComponent(value)}/`;
}

/**
 * Tracking link for a shipment: Shipway shipments get the Shipway page; anything
 * else (older Delhivery shipments, provider NULL) keeps the Delhivery page,
 * matching DELHIVERY_ONLY_SQL in shipmentProvider.js.
 */
export function trackingUrlFor(awb, provider) {
  const value = String(awb || "").trim();
  if (!value) return null;
  if (String(provider || "").trim().toLowerCase() === "shipway") return shipwayTrackingUrl(value);
  return `https://www.delhivery.com/track/package/${encodeURIComponent(value)}`;
}

const isOn = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());

export function getShippedTemplateConfig(env = process.env) {
  const buttonMode = String(env.INTERAKT_SHIPPED_BUTTON_MODE || "awb").trim().toLowerCase();
  return {
    enabled: isOn(env.INTERAKT_SHIPPED_ENABLED),
    templateName: String(env.INTERAKT_SHIPPED_TEMPLATE_NAME || "").trim() || DEFAULT_TEMPLATE_NAME,
    languageCode: String(env.INTERAKT_SHIPPED_TEMPLATE_LANGUAGE || "").trim() || "en",
    bodyFields: String(env.INTERAKT_SHIPPED_BODY_FIELDS || DEFAULT_BODY_FIELDS)
      .split(",").map((f) => f.trim().toLowerCase()).filter(Boolean),
    buttonMode: ["awb", "url", "none"].includes(buttonMode) ? buttonMode : "awb",
  };
}

export function buildShippedBodyValues(data, bodyFields) {
  const values = {
    name: String(data.name || "").trim() || "Customer",
    order_number: String(data.orderNumber || "").trim(),
    courier: String(data.courier || "").trim() || "our courier partner",
    awb: String(data.awb || "").trim(),
    tracking_url: String(data.trackingUrl || "").trim(),
    product: String(data.productName || "").trim() || DEFAULT_PRODUCT_NAME,
  };
  return bodyFields.map((field) => values[field] ?? "");
}

const maskPhone = (phone) => {
  const s = String(phone || "");
  return s.length <= 4 ? "****" : `${s.slice(0, 2)}****${s.slice(-2)}`;
};

let tableReady = false;
async function ensureNotificationTable(db) {
  if (tableReady) return;
  await db.query(
    `CREATE TABLE IF NOT EXISTS shipment_tracking_notifications (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       shipment_id BIGINT UNSIGNED NOT NULL,
       order_id BIGINT UNSIGNED NULL,
       awb VARCHAR(64) NULL,
       channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
       status VARCHAR(20) NOT NULL DEFAULT 'sending',
       attempts INT UNSIGNED NOT NULL DEFAULT 1,
       last_error VARCHAR(500) NULL,
       sent_at DATETIME NULL,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_tracking_notification (shipment_id, channel),
       KEY idx_tracking_notification_order (order_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  tableReady = true;
}

async function loadShipmentForNotification(shipmentId, db) {
  const sql = (withTestFlag) => `SELECT s.id AS shipment_id, s.order_id, s.waybill_number, s.provider, s.courier_name,
       o.customer_name, o.phone, o.order_number${withTestFlag ? ", COALESCE(o.is_test_order, 0) AS is_test_order" : ", 0 AS is_test_order"}
     FROM shipments s JOIN orders o ON o.id = s.order_id
     WHERE s.id = ? LIMIT 1`;
  try {
    return (await db.query(sql(true), [shipmentId])).rows[0] || null;
  } catch (error) {
    if (!isMissingColumnError(error, "is_test_order")) throw error;
    return (await db.query(sql(false), [shipmentId])).rows[0] || null;
  }
}

/**
 * Claim the single send for this shipment. Returns true when this caller may send.
 * A shipment that was already sent is never sent again unless force=true (admin resend);
 * a failed or skipped attempt may be retried (admin resend, or the next automatic trigger).
 */
async function claimSend(row, { force }, db) {
  try {
    await db.query(
      `INSERT INTO shipment_tracking_notifications (shipment_id, order_id, awb, channel, status)
       VALUES (?, ?, ?, 'whatsapp', 'sending')`,
      [row.shipment_id, row.order_id, row.waybill_number]
    );
    return true;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
  const allowed = force ? "('sent', 'failed', 'skipped')" : "('failed', 'skipped')";
  const retried = await db.query(
    `UPDATE shipment_tracking_notifications
     SET status = 'sending', awb = ?, attempts = attempts + 1, last_error = NULL
     WHERE shipment_id = ? AND channel = 'whatsapp' AND status IN ${allowed}`,
    [row.waybill_number, row.shipment_id]
  );
  return (retried.rowCount ?? retried.affectedRows ?? 0) === 1;
}

async function finishSend(shipmentId, status, error, db) {
  await db.query(
    `UPDATE shipment_tracking_notifications
     SET status = ?, last_error = ?, sent_at = CASE WHEN ? = 'sent' THEN NOW() ELSE sent_at END
     WHERE shipment_id = ? AND channel = 'whatsapp'`,
    [status, error ? String(error).slice(0, 500) : null, status, shipmentId]
  ).catch((e) => console.warn("[WhatsApp] Could not record tracking notification result", String(e?.message || e).slice(0, 200)));
}

/**
 * Send the shipped + tracking-link WhatsApp for a shipment.
 * @returns {Promise<{sent:boolean, skipped?:string, trackingUrl?:string|null, error?:string}>}
 */
export async function sendShipmentTrackingWhatsApp(shipmentId, { force = false, db = pool, env = process.env, send = sendInteraktTemplate } = {}) {
  const config = getShippedTemplateConfig(env);
  if (!config.enabled && !force) return { sent: false, skipped: "disabled" };

  const id = Number(shipmentId);
  if (!Number.isInteger(id) || id <= 0) return { sent: false, skipped: "invalid_shipment" };

  await ensureNotificationTable(db);
  const row = await loadShipmentForNotification(id, db);
  if (!row) return { sent: false, skipped: "shipment_not_found" };

  const awb = String(row.waybill_number || "").trim();
  if (!awb) return { sent: false, skipped: "no_awb" };
  if (String(row.provider || "").trim().toLowerCase() !== "shipway") return { sent: false, skipped: "not_shipway" };
  const trackingUrl = shipwayTrackingUrl(awb, env.SHIPWAY_TRACKING_BASE_URL);
  if (Number(row.is_test_order) === 1) return { sent: false, skipped: "test_order", trackingUrl };

  const parsed = normalizeIndianPhone(row.phone);
  if (parsed.error) return { sent: false, skipped: "invalid_phone", trackingUrl };

  if (!(await claimSend(row, { force }, db))) return { sent: false, skipped: "already_sent", trackingUrl };

  const orderNumber = String(row.order_number || row.order_id || "").trim();
  const buttonValue = config.buttonMode === "url" ? trackingUrl : awb;
  try {
    await send({
      countryCode: parsed.countryCode,
      phoneNumber: parsed.phoneNumber,
      callbackData: `order_shipped:${orderNumber}`.slice(0, 120),
      template: {
        name: config.templateName,
        languageCode: config.languageCode,
        bodyValues: buildShippedBodyValues({
          name: row.customer_name,
          orderNumber,
          courier: row.courier_name,
          awb,
          trackingUrl,
          productName: env.TELAQUA_PRODUCT_NAME,
        }, config.bodyFields),
        ...(config.buttonMode === "none" ? {} : { buttonValues: { 0: [buttonValue] } }),
      },
    });
  } catch (error) {
    const message = String(error?.message || "send failed");
    await finishSend(id, "failed", message, db);
    console.warn(`[WhatsApp] Shipped/tracking message failed for order ${orderNumber}`, message.slice(0, 200));
    return { sent: false, error: message, trackingUrl };
  }
  await finishSend(id, "sent", null, db);
  console.log(`[WhatsApp] Shipped/tracking message sent for order ${orderNumber}`, { phone: maskPhone(parsed.phoneNumber) });
  return { sent: true, trackingUrl };
}

/** Fire-and-forget after an AWB is saved. Never throws, never delays shipping. */
export function triggerShipmentTrackingWhatsAppAsync(shipmentId) {
  if (!shipmentId) return;
  Promise.resolve()
    .then(() => sendShipmentTrackingWhatsApp(shipmentId))
    .catch((error) => console.warn(
      `[WhatsApp] Shipped/tracking message error for shipment ${shipmentId}`,
      String(error?.message || error).slice(0, 200)
    ));
}

/** Test seam: reset the one-time table check. */
export function resetShipmentTrackingNotificationStateForTests() {
  tableReady = false;
}
