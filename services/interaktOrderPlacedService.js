/**
 * Interakt WhatsApp utility confirmation after a website order is saved/paid.
 * Reuses sendInteraktTemplate. Must never affect order or payment success.
 */

import { isMissingColumnError } from "../lib/dbErrors.js";
import { sendInteraktTemplate } from "./interaktService.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";

const DEFAULT_TEMPLATE_NAME = "order_placed_confirmation";
const DEFAULT_TEMPLATE_LANGUAGE = "en";

function maskPhone(phone) {
  const s = String(phone || "");
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

function isTestOrderFlag(value) {
  return value === true || value === 1 || value === "1" || Number(value) === 1;
}

export function formatOrderAmount(raw) {
  if (raw == null || raw === "") return "";
  const n = Number(raw);
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n - Math.round(n)) < 0.005) return String(Math.round(n));
  return n.toFixed(2);
}

export function getOrderPlacedTemplateConfig() {
  const templateName = String(
    process.env.INTERAKT_ORDER_PLACED_TEMPLATE_NAME || DEFAULT_TEMPLATE_NAME
  ).trim() || DEFAULT_TEMPLATE_NAME;
  const languageCode = String(
    process.env.INTERAKT_ORDER_PLACED_TEMPLATE_LANGUAGE || DEFAULT_TEMPLATE_LANGUAGE
  ).trim() || DEFAULT_TEMPLATE_LANGUAGE;
  return { templateName, languageCode };
}

async function loadOrderForConfirmation(orderDbId) {
  const id = Number(orderDbId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { query } = await import("../config/db.js");
  try {
    const { rows } = await query(
      `SELECT
         customer_name,
         phone,
         order_number,
         COALESCE(final_total, total_amount) AS amount,
         COALESCE(is_test_order, 0) AS is_test_order
       FROM orders
       WHERE id = ?
       LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  } catch (error) {
    if (isMissingColumnError(error, "is_test_order") || isMissingColumnError(error, "final_total")) {
      const { rows } = await query(
        `SELECT customer_name, phone, order_number, total_amount AS amount, 0 AS is_test_order
         FROM orders WHERE id = ? LIMIT 1`,
        [id]
      );
      return rows[0] || null;
    }
    throw error;
  }
}

/**
 * Send order_placed_confirmation. Skip (do not throw) for invalid phone / test orders.
 * Interakt API failures throw so the async trigger can log them.
 */
export async function sendOrderPlacedWhatsApp({
  customerName,
  customerPhone,
  orderId,
  orderAmount,
  orderDbId,
  isTestOrder,
} = {}) {
  let name = customerName;
  let phone = customerPhone;
  let number = orderId;
  let amount = orderAmount;
  let testFlag = isTestOrder;

  if (orderDbId && (phone == null || number == null || amount == null || name == null || testFlag == null)) {
    const row = await loadOrderForConfirmation(orderDbId);
    if (row) {
      if (name == null) name = row.customer_name;
      if (phone == null) phone = row.phone;
      if (number == null) number = row.order_number;
      if (amount == null) amount = row.amount;
      if (testFlag == null) testFlag = row.is_test_order;
    }
  }

  if (isTestOrderFlag(testFlag)) {
    return { skipped: true, reason: "test_order" };
  }

  const savedOrderId = String(number || "").trim();
  if (!savedOrderId) {
    console.warn("[WhatsApp] Order confirmation skipped: missing order ID");
    return { skipped: true, reason: "missing_order_id" };
  }

  const parsed = normalizeIndianPhone(phone);
  if (parsed.error) {
    console.warn(`[WhatsApp] Order confirmation skipped for order ${savedOrderId}: invalid phone`);
    return { skipped: true, reason: "invalid_phone" };
  }

  const amountStr = formatOrderAmount(amount);
  if (!amountStr) {
    console.warn(`[WhatsApp] Order confirmation skipped for order ${savedOrderId}: missing amount`);
    return { skipped: true, reason: "missing_amount" };
  }

  const displayName = String(name || "").trim() || "Customer";
  const { templateName, languageCode } = getOrderPlacedTemplateConfig();

  await sendInteraktTemplate({
    countryCode: parsed.countryCode,
    phoneNumber: parsed.phoneNumber,
    callbackData: `order_placed:${savedOrderId}`.slice(0, 120),
    template: {
      name: templateName,
      languageCode,
      bodyValues: [displayName, savedOrderId, amountStr],
    },
  });

  console.log(`[WhatsApp] Order confirmation sent for order ${savedOrderId}`);
  return { skipped: false, orderId: savedOrderId, phone: maskPhone(parsed.phoneNumber) };
}

export function triggerOrderPlacedWhatsAppAsync(payload) {
  if (!payload) return;
  sendOrderPlacedWhatsApp(payload).catch((error) => {
    const label = String(payload.orderId || payload.orderDbId || "unknown");
    console.warn(
      `[WhatsApp] Order confirmation failed for order ${label}`,
      String(error?.message || "send failed").slice(0, 200)
    );
  });
}
