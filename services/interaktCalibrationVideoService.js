/**
 * Interakt WhatsApp marketing template after a customer order is saved.
 * Template: telaqua_calibration_video (approved).
 * Body {{1}} is the customer name. The Telugu and Hindi video buttons are
 * static URLs on the Interakt template, so this send does not pass button values.
 * INTERAKT_API_KEY stays server-side only. A failure never changes the order.
 */

import { isMissingColumnError } from "../lib/dbErrors.js";
import { sendInteraktTemplate } from "./interaktService.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";

const DEFAULT_TEMPLATE_NAME = "telaqua_calibration_video";
const DEFAULT_TEMPLATE_LANGUAGE = "en";

function maskPhone(phone) {
  const s = String(phone || "");
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

function isOn(value, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function isTestOrderFlag(value) {
  return value === true || value === 1 || value === "1" || Number(value) === 1;
}

export function calibrationGreetingName(customerName) {
  const name = String(customerName || "").replace(/\s+/g, " ").trim();
  return (name || "Customer").slice(0, 60);
}

export function getCalibrationTemplateConfig(env = process.env) {
  return {
    enabled: isOn(env.INTERAKT_CALIBRATION_ENABLED, true),
    requireConsent: isOn(env.INTERAKT_CALIBRATION_REQUIRE_CONSENT, false),
    templateName: String(env.INTERAKT_CALIBRATION_TEMPLATE_NAME || DEFAULT_TEMPLATE_NAME).trim() || DEFAULT_TEMPLATE_NAME,
    languageCode: String(env.INTERAKT_CALIBRATION_TEMPLATE_LANGUAGE || DEFAULT_TEMPLATE_LANGUAGE).trim() || DEFAULT_TEMPLATE_LANGUAGE,
  };
}

let columnReady = false;

async function ensureCalibrationColumn(query) {
  if (columnReady) return;
  try {
    await query(
      `ALTER TABLE orders ADD COLUMN calibration_whatsapp_status VARCHAR(20) NULL`
    );
  } catch (error) {
    const duplicate = error?.code === "ER_DUP_FIELDNAME" || /duplicate column/i.test(String(error?.message || ""));
    if (!duplicate && !isMissingColumnError(error, "calibration_whatsapp_status")) throw error;
  }
  columnReady = true;
}

async function loadOrder(orderDbId) {
  const id = Number(orderDbId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { query } = await import("../config/db.js");
  await ensureCalibrationColumn(query);
  try {
    const { rows } = await query(
      `SELECT customer_name, phone, order_number,
              COALESCE(is_test_order, 0) AS is_test_order,
              COALESCE(whatsapp_updates_consent, 0) AS whatsapp_updates_consent,
              calibration_whatsapp_status
       FROM orders WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  } catch (error) {
    if (!isMissingColumnError(error, "is_test_order") && !isMissingColumnError(error, "whatsapp_updates_consent")) {
      throw error;
    }
    const { rows } = await query(
      `SELECT customer_name, phone, order_number, 0 AS is_test_order, 0 AS whatsapp_updates_consent,
              calibration_whatsapp_status
       FROM orders WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  }
}

async function claimSend(orderDbId) {
  const id = Number(orderDbId);
  if (!Number.isInteger(id) || id <= 0) return true;
  const { query } = await import("../config/db.js");
  await ensureCalibrationColumn(query);
  const claimed = await query(
    `UPDATE orders
     SET calibration_whatsapp_status = 'sending'
     WHERE id = ?
       AND (calibration_whatsapp_status IS NULL OR calibration_whatsapp_status = 'failed')`,
    [id]
  );
  return Number(claimed.rowCount || 0) > 0;
}

async function markStatus(orderDbId, status) {
  const id = Number(orderDbId);
  if (!Number.isInteger(id) || id <= 0) return;
  const { query } = await import("../config/db.js");
  await query(
    `UPDATE orders SET calibration_whatsapp_status = ? WHERE id = ?`,
    [status, id]
  );
}

/**
 * Send telaqua_calibration_video once per order.
 * Skip (do not throw) for disabled config, test orders, invalid phones, and repeats.
 */
export async function sendCalibrationVideoWhatsApp({
  customerName,
  customerPhone,
  orderId,
  orderDbId,
  isTestOrder,
  whatsappConsent,
} = {}) {
  const config = getCalibrationTemplateConfig();
  if (!config.enabled) return { skipped: true, reason: "disabled" };

  let name = customerName;
  let phone = customerPhone;
  let number = orderId;
  let testFlag = isTestOrder;
  let consent = whatsappConsent;

  if (orderDbId && (name == null || phone == null || number == null || testFlag == null || consent == null)) {
    const row = await loadOrder(orderDbId);
    if (row) {
      if (name == null) name = row.customer_name;
      if (phone == null) phone = row.phone;
      if (number == null) number = row.order_number;
      if (testFlag == null) testFlag = row.is_test_order;
      if (consent == null) consent = row.whatsapp_updates_consent;
      if (row.calibration_whatsapp_status === "sent" || row.calibration_whatsapp_status === "sending") {
        return { skipped: true, reason: "already_sent" };
      }
    }
  }

  if (isTestOrderFlag(testFlag)) return { skipped: true, reason: "test_order" };

  const savedOrderId = String(number || "").trim();
  if (!savedOrderId) return { skipped: true, reason: "missing_order_id" };

  if (config.requireConsent && !isTestOrderFlag(consent) && consent !== true) {
    return { skipped: true, reason: "no_consent" };
  }

  const parsed = normalizeIndianPhone(phone);
  if (parsed.error) return { skipped: true, reason: "invalid_phone" };

  const claimed = await claimSend(orderDbId);
  if (!claimed) return { skipped: true, reason: "already_sent" };

  try {
    const result = await sendInteraktTemplate({
      countryCode: parsed.countryCode,
      phoneNumber: parsed.phoneNumber,
      callbackData: `calibration_video:${savedOrderId}`.slice(0, 120),
      template: {
        name: config.templateName,
        languageCode: config.languageCode,
        bodyValues: [calibrationGreetingName(name)],
      },
    });
    await markStatus(orderDbId, "sent");
    console.log(`[WhatsApp] Calibration video sent for order ${savedOrderId}`);
    return {
      skipped: false,
      orderId: savedOrderId,
      phone: maskPhone(parsed.phoneNumber),
      messageId: result?.messageId || null,
    };
  } catch (error) {
    await markStatus(orderDbId, "failed").catch(() => {});
    throw error;
  }
}

export function triggerCalibrationVideoWhatsAppAsync(payload) {
  if (!payload) return;
  sendCalibrationVideoWhatsApp(payload).catch((error) => {
    const label = String(payload.orderId || payload.orderDbId || "unknown");
    console.warn(
      `[WhatsApp] Calibration video failed for order ${label}`,
      String(error?.message || "send failed").slice(0, 200)
    );
  });
}
