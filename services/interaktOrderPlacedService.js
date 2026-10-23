/**
 * Interakt WhatsApp utility confirmation after a website order is saved/paid.
 * Reuses sendInteraktTemplate. Must never affect order or payment success.
 */

import crypto from "node:crypto";
import { isMissingColumnError } from "../lib/dbErrors.js";
import { ensureInvoiceLinkTokenColumn, hashInvoiceLinkToken } from "./invoiceWhatsAppService.js";
import { sendInteraktTemplate } from "./interaktService.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";

const DEFAULT_TEMPLATE_NAME = "order_placed_confirmation";
const DEFAULT_TEMPLATE_LANGUAGE = "en";
/* Body {{n}} values in template order. Default keeps the original 3-variable template.
 * Allowed: name, product, order_number, amount
 * e.g. INTERAKT_ORDER_PLACED_BODY_FIELDS=name,product,order_number,amount */
const DEFAULT_BODY_FIELDS = "name,order_number,amount";
const DEFAULT_PRODUCT_NAME = "Tel-Aqua pH Meter";
/* Dynamic "Download Your Invoice" URL button.
 * INTERAKT_ORDER_PLACED_BUTTON_MODE:
 *   (empty) - template has no dynamic button (default, unchanged behaviour)
 *   ref     - button URL in Interakt is https://<backend>/i/{{1}} (or /i/?{{1}});
 *             sends "<orderId>-<64 hex token>"
 *   url     - button URL in Interakt is {{1}}; sends the full https link */
const DEFAULT_LINK_BASE = "https://lightpink-reindeer-561421.hostingersite.com";

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
  const bodyFields = String(process.env.INTERAKT_ORDER_PLACED_BODY_FIELDS || DEFAULT_BODY_FIELDS)
    .split(",")
    .map((field) => field.trim().toLowerCase())
    .filter(Boolean);
  const buttonMode = String(process.env.INTERAKT_ORDER_PLACED_BUTTON_MODE || "").trim().toLowerCase();
  return {
    templateName,
    languageCode,
    bodyFields,
    ...(buttonMode === "ref" || buttonMode === "url" ? { buttonMode } : {}),
  };
}

/**
 * Create a per-order secure invoice link for the WhatsApp button.
 * Uses the same token column and /i/<orderId>-<token> route as the invoice-link WhatsApp flow,
 * so routes/invoiceLink.js serves the PDF for exactly this order.
 */
export async function createOrderInvoiceLinkRef(orderDbId) {
  const id = Number(orderDbId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { query } = await import("../config/db.js");
  await ensureInvoiceLinkTokenColumn();
  const token = crypto.randomBytes(32).toString("hex");
  const updated = await query(
    `UPDATE orders SET whatsapp_invoice_token_hash = ? WHERE id = ?`,
    [hashInvoiceLinkToken(token), id]
  );
  return updated.rowCount ? `${id}-${token}` : null;
}

export function buildOrderPlacedButtonValue(ref, buttonMode, linkBase = process.env.BACKEND_BASE_URL) {
  if (!ref) return "";
  if (buttonMode === "url") {
    const base = String(linkBase || DEFAULT_LINK_BASE).trim().replace(/\/+$/, "");
    return `${base}/i/${ref}`;
  }
  return ref;
}

/** Body values in the order the approved template expects. */
export function buildOrderPlacedBodyValues({ name, orderId, amount, productName }, bodyFields) {
  const values = {
    name: String(name || "").trim() || "Customer",
    product: String(productName || "").trim() || DEFAULT_PRODUCT_NAME,
    order_number: String(orderId || "").trim(),
    amount: String(amount || "").trim(),
  };
  return bodyFields.map((field) => values[field] ?? "");
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
  const { templateName, languageCode, bodyFields, buttonMode } = getOrderPlacedTemplateConfig();

  let buttonValues;
  if (buttonMode) {
    const ref = await createOrderInvoiceLinkRef(orderDbId);
    if (!ref) {
      console.warn(`[WhatsApp] Order confirmation skipped for order ${savedOrderId}: invoice link unavailable`);
      return { skipped: true, reason: "invoice_link_unavailable" };
    }
    buttonValues = { 0: [buildOrderPlacedButtonValue(ref, buttonMode)] };
  }

  await sendInteraktTemplate({
    countryCode: parsed.countryCode,
    phoneNumber: parsed.phoneNumber,
    callbackData: `order_placed:${savedOrderId}`.slice(0, 120),
    template: {
      name: templateName,
      languageCode,
      bodyValues: buildOrderPlacedBodyValues({
        name: displayName,
        orderId: savedOrderId,
        amount: amountStr,
        productName: process.env.TELAQUA_PRODUCT_NAME,
      }, bodyFields),
      ...(buttonValues ? { buttonValues } : {}),
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
