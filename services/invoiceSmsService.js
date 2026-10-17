/**
 * services/invoiceSmsService.js
 *
 * After an order is confirmed (COD or prepaid), send the approved Fast2SMS DLT
 * template with a per-order invoice link:
 *
 *   FAST2SMS_INVOICE_LINK_MODE=ref (default) — matches the DLT template
 *     "... Download invoice: https://<backend>/i/?{#var#}"
 *     and sends only "<orderId>-<14 char token>" as the last variable.
 *     Customer link: https://<backend>/i/?1078-k3Jf9xQa2LmPzZ
 *   FAST2SMS_INVOICE_LINK_MODE=url — for a template "... Download invoice: {#var#}"
 *     and sends the full "https://<backend>/i/?<orderId>-<token>" as the last variable.
 *   Both forms (/i/?<ref> and /i/<ref>) are served by routes/invoiceLink.js.
 *
 * Only the SHA-256 hash of the token is stored (orders.sms_invoice_token_hash).
 * This token is separate from the WhatsApp token (whatsapp_invoice_token_hash) so
 * sending one never invalidates the other link.
 * Failures are logged and never affect order, payment, or invoice processing.
 */

import crypto from "node:crypto";
import { query } from "../config/db.js";
import { ensureColumn } from "../lib/schemaHelpers.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";
import { canGenerateOrderInvoice, loadOrderForFulfillment } from "./invoiceService.js";

const FAST2SMS_URL = "https://www.fast2sms.com/dev/bulkV2";
const TOKEN_LENGTH = 14;
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const DLT_VAR_MAX = 30;
const DEFAULT_VARIABLES = "name,order_number,amount,link";
const DEFAULT_LINK_BASE = "https://lightpink-reindeer-561421.hostingersite.com";
let columnsReady = false;

/* ------------------------------------------------------------------ tokens */

export function generateSmsInvoiceToken() {
  // Rejection sampling keeps the alphabet unbiased (62 chars, ~83 bits for 14 chars).
  let out = "";
  while (out.length < TOKEN_LENGTH) {
    for (const byte of crypto.randomBytes(TOKEN_LENGTH * 2)) {
      if (byte < 248) out += TOKEN_ALPHABET[byte % 62];
      if (out.length === TOKEN_LENGTH) break;
    }
  }
  return out;
}

export function hashSmsInvoiceToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

/** Parse "<orderId>-<14 char alphanumeric token>" from the /i/:ref link. */
export function parseSmsInvoiceLinkRef(ref) {
  const match = new RegExp(`^(\\d{1,12})-([A-Za-z0-9]{${TOKEN_LENGTH}})$`)
    .exec(String(ref || "").trim());
  if (!match) return null;
  const orderId = Number(match[1]);
  if (!Number.isSafeInteger(orderId) || orderId <= 0) return null;
  return { orderId, token: match[2] };
}

export function isValidSmsInvoiceToken(storedHash, token) {
  const expected = Buffer.from(String(storedHash || ""), "utf8");
  const actual = Buffer.from(hashSmsInvoiceToken(token), "utf8");
  return expected.length > 0 &&
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual);
}

/* ------------------------------------------------------------------ config */

export function getFast2SmsConfig() {
  return {
    apiKey: String(process.env.FAST2SMS_API_KEY || "").trim(),
    senderId: String(process.env.FAST2SMS_SENDER_ID || "").trim(),
    messageId: String(process.env.FAST2SMS_INVOICE_MESSAGE_ID || "").trim(),
    // Must match the whitelisted DLT CTA domain (https://<backend>/i/?).
    linkBase: String(
      process.env.FAST2SMS_INVOICE_LINK_BASE ||
      process.env.BACKEND_BASE_URL ||
      DEFAULT_LINK_BASE
    ).trim().replace(/\/+$/, ""),
    linkMode: String(process.env.FAST2SMS_INVOICE_LINK_MODE || "ref").trim().toLowerCase() === "url"
      ? "url"
      : "ref",
    variables: String(process.env.FAST2SMS_INVOICE_VARIABLES || DEFAULT_VARIABLES)
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  };
}

export function isFast2SmsConfigured(config = getFast2SmsConfig()) {
  return Boolean(config.apiKey && config.senderId && config.messageId);
}

/* --------------------------------------------------------------- variables */

function formatAmount(raw) {
  const n = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(n)) return "";
  if (Math.abs(n - Math.round(n)) < 0.005) return String(Math.round(n));
  return n.toFixed(2);
}

/** DLT variables: no pipe (Fast2SMS separator), single line, max 30 chars for text. */
function cleanVar(value, maxLength = DLT_VAR_MAX) {
  return String(value ?? "")
    .replace(/[|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

/** Full invoice URL sent in the URL-tagged DLT variable. */
export function buildSmsInvoiceLink(linkBase, linkRef) {
  return `${String(linkBase || DEFAULT_LINK_BASE).replace(/\/+$/, "")}/i/?${linkRef}`;
}

/**
 * Build Fast2SMS variables_values in template order.
 * Supported names: name, order_number, amount, link.
 */
export function buildSmsVariablesValues(order, linkValue, variables = DEFAULT_VARIABLES.split(",")) {
  const firstName = String(order.customer_name || "").trim().split(/\s+/)[0];
  const values = {
    name: firstName || "Customer",
    order_number: String(order.order_number || order.id || ""),
    amount: formatAmount(order.final_total ?? order.total_amount),
    link: linkValue,
  };
  return variables
    .map((key) => {
      const value = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : "";
      // The URL variable must never be cut short.
      return key === "link" ? cleanVar(value, 500) : cleanVar(value);
    })
    .join("|");
}

/* ------------------------------------------------------------------ schema */

export async function ensureSmsInvoiceColumns() {
  if (columnsReady) return;
  const columns = [
    ["sms_invoice_token_hash", "CHAR(64) NULL"],
    ["sms_invoice_status", "VARCHAR(20) NULL"],
    ["sms_invoice_request_id", "VARCHAR(100) NULL"],
    ["sms_invoice_sent_at", "TIMESTAMP NULL"],
    ["sms_invoice_error", "VARCHAR(500) NULL"],
  ];
  for (const [name, type] of columns) {
    await ensureColumn("orders", name, `ALTER TABLE orders ADD COLUMN ${name} ${type}`);
  }
  columnsReady = true;
}

async function updateSmsStatus(orderId, fields) {
  const sets = [];
  const params = [];
  for (const [column, value] of Object.entries(fields)) {
    if (value === "__NOW__") {
      sets.push(`${column} = CURRENT_TIMESTAMP`);
    } else {
      sets.push(`${column} = ?`);
      params.push(value);
    }
  }
  if (!sets.length) return;
  try {
    await query(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`, [...params, orderId]);
  } catch (error) {
    console.warn("[InvoiceSms] Could not update SMS status columns", {
      orderId,
      message: error?.message,
    });
  }
}

/* ------------------------------------------------------------------- send */

export async function sendFast2SmsDlt({ config, phoneNumber, variablesValues }) {
  const response = await fetch(FAST2SMS_URL, {
    method: "POST",
    headers: {
      authorization: config.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      route: "dlt",
      sender_id: config.senderId,
      message: config.messageId,
      variables_values: variablesValues,
      numbers: phoneNumber,
      flash: 0,
    }),
    signal: AbortSignal.timeout(15000),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || data?.return !== true) {
    const detail = Array.isArray(data?.message) ? data.message.join("; ") : data?.message;
    throw new Error(`Fast2SMS error (HTTP ${response.status}): ${detail || "unknown error"}`);
  }
  return { requestId: data.request_id ? String(data.request_id) : null };
}

/**
 * Send the invoice-link SMS for one order.
 * Sends at most once per order (claimed atomically via sms_invoice_token_hash).
 * @param {number} orderId
 * @param {{ force?: boolean }} [options] force = resend with a new link (old SMS link stops working)
 */
export async function sendInvoiceLinkSms(orderId, { force = false } = {}) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return { skipped: true, reason: "invalid_order_id" };

  const config = getFast2SmsConfig();
  if (!isFast2SmsConfigured(config)) return { skipped: true, reason: "fast2sms_not_configured" };

  const order = await loadOrderForFulfillment(id);
  if (!order) return { skipped: true, reason: "not_found" };
  if (Number(order.is_test_order) === 1) return { skipped: true, reason: "test_order" };
  if (!canGenerateOrderInvoice(order)) return { skipped: true, reason: "not_eligible" };

  await ensureSmsInvoiceColumns();

  const phone = normalizeIndianPhone(order.phone);
  if (phone.error) {
    await updateSmsStatus(id, {
      sms_invoice_status: "failed",
      sms_invoice_error: "Invalid customer phone number",
    });
    return { skipped: true, reason: "invalid_phone" };
  }

  const token = generateSmsInvoiceToken();
  const linkRef = `${id}-${token}`;
  let linkValue = linkRef;
  if (config.linkMode === "url") {
    linkValue = buildSmsInvoiceLink(config.linkBase, linkRef);
    if (!/^https?:\/\//i.test(linkValue)) return { skipped: true, reason: "invalid_link_base" };
  }

  // Claim: only one sender wins (verify-payment and the Razorpay webhook can both fire).
  const claim = await query(
    `UPDATE orders SET sms_invoice_token_hash = ?
     WHERE id = ? AND (? = 1 OR sms_invoice_token_hash IS NULL)`,
    [hashSmsInvoiceToken(token), id, force ? 1 : 0]
  );
  if (!claim.rowCount) return { skipped: true, reason: "already_sent" };

  await updateSmsStatus(id, { sms_invoice_status: "sending", sms_invoice_error: null });

  try {
    const result = await sendFast2SmsDlt({
      config,
      phoneNumber: phone.phoneNumber,
      variablesValues: buildSmsVariablesValues(order, linkValue, config.variables),
    });
    await updateSmsStatus(id, {
      sms_invoice_status: "sent",
      sms_invoice_request_id: result.requestId,
      sms_invoice_sent_at: "__NOW__",
      sms_invoice_error: null,
    });
    console.log(`[InvoiceSms] Invoice link SMS sent for order ${order.order_number || id}`);
    return { skipped: false, sent: true, requestId: result.requestId };
  } catch (error) {
    const safe = String(error?.message || "Fast2SMS send failed").slice(0, 500);
    // Release the claim so a later confirmation event (or a retry) can send again.
    await query(
      `UPDATE orders SET sms_invoice_token_hash = NULL
       WHERE id = ? AND sms_invoice_token_hash = ?`,
      [id, hashSmsInvoiceToken(token)]
    ).catch(() => {});
    await updateSmsStatus(id, { sms_invoice_status: "failed", sms_invoice_error: safe });
    throw error;
  }
}

/** Fire-and-forget wrapper used after order fulfillment. Never throws. */
export function triggerInvoiceLinkSmsAsync(orderId) {
  if (!orderId) return;
  sendInvoiceLinkSms(orderId)
    .then((result) => {
      if (result?.skipped && result.reason !== "already_sent") {
        console.log(`[InvoiceSms] Skipped for order ${orderId}: ${result.reason}`);
      }
    })
    .catch((error) => {
      console.warn(
        `[InvoiceSms] Failed for order ${orderId}:`,
        String(error?.message || "send failed").slice(0, 200)
      );
    });
}
