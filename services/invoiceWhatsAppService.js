/**
 * services/invoiceWhatsAppService.js
 *
 * After an order is confirmed, send the approved MyOperator utility template with a
 * per-order "Download Your Invoice" button:
 *
 *   Template button URL : https://<backend>/i/{{1}}
 *   Button value sent   : "<orderId>-<64-hex token>"
 *
 * Only the SHA-256 hash of the token is stored (orders.whatsapp_invoice_token_hash).
 * This token is separate from invoice_access_token_hash used by the checkout pages.
 * Failures are logged and never affect order, payment, or invoice processing.
 */

import crypto from "node:crypto";
import { query } from "../config/db.js";
import { ensureColumn } from "../lib/schemaHelpers.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";
import { canGenerateOrderInvoice, loadOrderForFulfillment } from "./invoiceService.js";
import { isMyOperatorConfigured, sendMyOperatorTemplate } from "./myOperatorService.js";

const DEFAULT_BODY_KEYS = "var_1,var_2,var_3";
let tokenColumnReady = false;

export function hashInvoiceLinkToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

/** Parse "<orderId>-<64 hex token>" from the /i/:ref link. */
export function parseInvoiceLinkRef(ref) {
  const match = /^(\d{1,12})-([a-f0-9]{64})$/.exec(String(ref || "").trim());
  if (!match) return null;
  const orderId = Number(match[1]);
  if (!Number.isSafeInteger(orderId) || orderId <= 0) return null;
  return { orderId, token: match[2] };
}

export function isValidInvoiceLinkToken(storedHash, token) {
  const expected = Buffer.from(String(storedHash || ""), "utf8");
  const actual = Buffer.from(hashInvoiceLinkToken(token), "utf8");
  return expected.length > 0 &&
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual);
}

export function formatInvoiceAmount(raw) {
  const n = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(n)) return "";
  if (Math.abs(n - Math.round(n)) < 0.005) return String(Math.round(n));
  return n.toFixed(2);
}

export function getInvoiceTemplateConfig() {
  const keys = String(process.env.MYOPERATOR_INVOICE_BODY_KEYS || DEFAULT_BODY_KEYS)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return {
    templateName: String(process.env.MYOPERATOR_INVOICE_TEMPLATE || "").trim(),
    language: String(process.env.MYOPERATOR_TEMPLATE_LANGUAGE || "en").trim() || "en",
    bodyKeys: keys,
    requireConsent: String(process.env.INVOICE_WHATSAPP_REQUIRE_CONSENT || "false")
      .trim()
      .toLowerCase() === "true",
  };
}

/** Body values in template order: customer name, order number, amount. */
export function buildInvoiceTemplateBody(order, bodyKeys) {
  const values = [
    String(order.customer_name || "").trim() || "Customer",
    String(order.order_number || order.id || ""),
    formatInvoiceAmount(order.final_total ?? order.total_amount),
  ];
  const body = {};
  bodyKeys.forEach((key, index) => {
    if (index < values.length) body[key] = values[index];
  });
  return body;
}

export async function ensureInvoiceLinkTokenColumn() {
  if (tokenColumnReady) return;
  await ensureColumn(
    "orders",
    "whatsapp_invoice_token_hash",
    `ALTER TABLE orders ADD COLUMN whatsapp_invoice_token_hash CHAR(64) NULL`
  );
  tokenColumnReady = true;
}

async function updateWhatsappStatus(orderId, fields) {
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
    console.warn("[InvoiceWhatsApp] Could not update WhatsApp status columns", {
      orderId,
      message: error?.message,
    });
  }
}

/**
 * Send the invoice-link template for one order.
 * Sends at most once per order (claimed atomically via whatsapp_invoice_token_hash).
 * @param {number} orderId
 * @param {{ force?: boolean }} [options] force = resend with a new link (old link stops working)
 */
export async function sendInvoiceLinkWhatsApp(orderId, { force = false } = {}) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return { skipped: true, reason: "invalid_order_id" };

  if (!isMyOperatorConfigured()) return { skipped: true, reason: "myoperator_not_configured" };
  const config = getInvoiceTemplateConfig();
  if (!config.templateName) return { skipped: true, reason: "template_not_configured" };

  const order = await loadOrderForFulfillment(id);
  if (!order) return { skipped: true, reason: "not_found" };
  if (Number(order.is_test_order) === 1) return { skipped: true, reason: "test_order" };
  if (!canGenerateOrderInvoice(order)) return { skipped: true, reason: "not_eligible" };
  if (config.requireConsent && !force && !Number(order.whatsapp_updates_consent)) {
    return { skipped: true, reason: "no_consent" };
  }

  const phone = normalizeIndianPhone(order.phone);
  if (phone.error) {
    await updateWhatsappStatus(id, {
      whatsapp_invoice_status: "failed",
      whatsapp_invoice_error: "Invalid customer phone number",
    });
    return { skipped: true, reason: "invalid_phone" };
  }

  await ensureInvoiceLinkTokenColumn();

  // Claim: only one sender wins (verify-payment and the Razorpay webhook can both fire).
  const token = crypto.randomBytes(32).toString("hex");
  const claim = await query(
    `UPDATE orders SET whatsapp_invoice_token_hash = ?
     WHERE id = ? AND (? = 1 OR whatsapp_invoice_token_hash IS NULL)`,
    [hashInvoiceLinkToken(token), id, force ? 1 : 0]
  );
  if (!claim.rowCount) return { skipped: true, reason: "already_sent" };

  await updateWhatsappStatus(id, {
    whatsapp_invoice_status: "sending",
    whatsapp_invoice_error: null,
  });

  try {
    const result = await sendMyOperatorTemplate({
      countryCode: phone.countryCode,
      phoneNumber: phone.phoneNumber,
      templateName: config.templateName,
      language: config.language,
      body: buildInvoiceTemplateBody(order, config.bodyKeys),
      buttons: [{ index: 0, var1: `${id}-${token}` }],
      refId: `invoice:${id}`,
    });
    await updateWhatsappStatus(id, {
      whatsapp_invoice_status: "sent",
      whatsapp_invoice_message_id: result.messageId ? String(result.messageId) : null,
      whatsapp_invoice_sent_at: "__NOW__",
      whatsapp_invoice_error: null,
    });
    console.log(`[InvoiceWhatsApp] Invoice link sent for order ${order.order_number || id}`);
    return { skipped: false, sent: true, messageId: result.messageId };
  } catch (error) {
    const safe = String(error?.message || "MyOperator send failed").slice(0, 500);
    // Release the claim so a later confirmation event (or a retry) can send again.
    await query(
      `UPDATE orders SET whatsapp_invoice_token_hash = NULL
       WHERE id = ? AND whatsapp_invoice_token_hash = ?`,
      [id, hashInvoiceLinkToken(token)]
    ).catch(() => {});
    await updateWhatsappStatus(id, {
      whatsapp_invoice_status: "failed",
      whatsapp_invoice_error: safe,
    });
    throw error;
  }
}

/** Fire-and-forget wrapper used after order fulfillment. Never throws. */
export function triggerInvoiceLinkWhatsAppAsync(orderId) {
  if (!orderId) return;
  sendInvoiceLinkWhatsApp(orderId)
    .then((result) => {
      if (result?.skipped && result.reason !== "already_sent") {
        console.log(`[InvoiceWhatsApp] Skipped for order ${orderId}: ${result.reason}`);
      }
    })
    .catch((error) => {
      console.warn(
        `[InvoiceWhatsApp] Failed for order ${orderId}:`,
        String(error?.message || "send failed").slice(0, 200)
      );
    });
}
