/**
 * services/whatsappConsent.js
 *
 * Parse WhatsApp updates consent from order/payment create bodies.
 * Consent is stored only when the order row is inserted — never earlier.
 */

import { ensureColumn } from "../lib/schemaHelpers.js";

let whatsappColumnsReady = false;

const CONSENT_KEYS = [
  "whatsapp_opt_in",
  "whatsapp_updates_consent",
  "whatsappConsent",
  "whatsapp_consent",
  "receiveWhatsappUpdates",
];

/**
 * Ensure WhatsApp consent columns exist (idempotent).
 */
export async function ensureWhatsappConsentColumns() {
  if (whatsappColumnsReady) return;
  await ensureColumn(
    "orders",
    "whatsapp_updates_consent",
    `ALTER TABLE orders
     ADD COLUMN whatsapp_updates_consent TINYINT(1) NOT NULL DEFAULT 0`
  );
  await ensureColumn(
    "orders",
    "whatsapp_consent_at",
    `ALTER TABLE orders ADD COLUMN whatsapp_consent_at DATETIME NULL`
  );
  whatsappColumnsReady = true;
}

/**
 * Resolve the first present consent field from the request body.
 * @param {object} body
 * @returns {unknown}
 */
function pickConsentRaw(body) {
  for (const key of CONSENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      const value = body[key];
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * Normalize common client truthy/falsy forms to a boolean or null (unknown).
 * @param {unknown} raw
 * @returns {boolean|null}
 */
function normalizeConsentValue(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "number") {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return null;
  }
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no" || s === "") return false;
    return null;
  }
  return null;
}

/**
 * Validate and normalize whatsapp_updates_consent from a request body.
 * Missing/null → false (backward compatible with older clients).
 * Accepts boolean, common string/number forms, and alias keys.
 *
 * @param {object} body
 * @returns {{ whatsapp_updates_consent: boolean, whatsapp_consent_at: Date|null }}
 */
export function parseWhatsappConsent(body) {
  if (!body || typeof body !== "object") {
    return {
      whatsapp_updates_consent: false,
      whatsapp_consent_at: null,
    };
  }

  const raw = pickConsentRaw(body);
  const normalized = normalizeConsentValue(raw);

  if (normalized === true) {
    return {
      whatsapp_updates_consent: true,
      whatsapp_consent_at: new Date(),
    };
  }

  return {
    whatsapp_updates_consent: false,
    whatsapp_consent_at: null,
  };
}
