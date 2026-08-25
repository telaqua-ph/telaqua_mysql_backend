/**
 * Interakt WhatsApp checkout reminder (Marketing template).
 * Separate from OTP (interaktOtpService) and invoice WhatsApp.
 * INTERAKT_API_KEY stays server-side only.
 * CTA URL is configured on the Interakt template — not sent from code.
 */

import { sendInteraktTemplate } from "./interaktService.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";

const DEFAULT_TEMPLATE_NAME = "telaqua_checkout_reminder";
const DEFAULT_TEMPLATE_LANGUAGE = "en";

function maskPhone(phone) {
  const s = String(phone || "");
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

export function extractFirstName(customerName) {
  const raw = String(customerName || "").trim();
  if (!raw) return "";
  const first = raw.split(/\s+/).find(Boolean) || "";
  return first.slice(0, 40);
}

export function getCheckoutReminderTemplateConfig() {
  const templateName = String(
    process.env.INTERAKT_CHECKOUT_TEMPLATE_NAME || DEFAULT_TEMPLATE_NAME
  ).trim();
  const languageCode =
    String(process.env.INTERAKT_CHECKOUT_TEMPLATE_LANGUAGE || DEFAULT_TEMPLATE_LANGUAGE).trim() ||
    DEFAULT_TEMPLATE_LANGUAGE;
  return { templateName, languageCode };
}

/**
 * Send telaqua_checkout_reminder. Body {{1}} = first name.
 */
export async function sendCheckoutReminder({
  customerName,
  phone,
  orderId,
  reason,
} = {}) {
  const firstName = extractFirstName(customerName);
  if (!firstName) {
    const err = new Error("Customer name is required");
    err.code = "CHECKOUT_REMINDER_INVALID_NAME";
    throw err;
  }

  const parsed = normalizeIndianPhone(phone);
  if (parsed.error) {
    const err = new Error(parsed.error);
    err.code = "CHECKOUT_REMINDER_INVALID_PHONE";
    throw err;
  }

  const { templateName, languageCode } = getCheckoutReminderTemplateConfig();
  if (!templateName) {
    const err = new Error("INTERAKT_CHECKOUT_TEMPLATE_NAME is not configured");
    err.code = "CHECKOUT_REMINDER_CONFIG";
    throw err;
  }

  const orderLabel = String(orderId || "").trim();
  const reasonLabel = String(reason || "checkout_abandoned").trim();

  console.log("Checkout reminder Interakt send:", {
    template: templateName,
    phone: maskPhone(parsed.phoneNumber),
    orderId: orderLabel || null,
    reason: reasonLabel,
  });

  const result = await sendInteraktTemplate({
    countryCode: parsed.countryCode,
    phoneNumber: parsed.phoneNumber,
    callbackData: `checkout_reminder:${reasonLabel}:${orderLabel}`.slice(0, 120),
    template: {
      name: templateName,
      languageCode,
      bodyValues: [firstName],
    },
  });

  return {
    success: true,
    messageId: result?.messageId || null,
    phoneNumber: parsed.phoneNumber,
  };
}
