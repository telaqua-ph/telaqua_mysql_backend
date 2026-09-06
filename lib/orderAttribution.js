/**
 * Optional marketing attribution on website COD / Razorpay create-order.
 * Missing or invalid values must never fail order creation.
 */

export const ORDER_ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "fbp",
  "fbc",
  "landing_url",
  "first_seen_at",
];

const MAX_LEN = {
  utm_source: 255,
  utm_medium: 255,
  utm_campaign: 255,
  utm_term: 255,
  utm_content: 255,
  gclid: 255,
  fbclid: 255,
  fbp: 255,
  fbc: 255,
  landing_url: 2048,
  first_seen_at: 40,
};

function sanitizeText(value, max) {
  if (value == null) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

function sanitizeFirstSeenAt(value) {
  const text = sanitizeText(value, 40);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function parseOrderAttribution(body) {
  const src = body && typeof body === "object" ? body : {};
  const out = {};
  for (const key of ORDER_ATTRIBUTION_KEYS) {
    if (key === "first_seen_at") {
      out[key] = sanitizeFirstSeenAt(src[key]);
    } else {
      out[key] = sanitizeText(src[key], MAX_LEN[key] || 255);
    }
  }
  return out;
}

export function attributionValues(attr) {
  return ORDER_ATTRIBUTION_KEYS.map((key) => attr?.[key] ?? null);
}

export function isMissingAttributionColumnError(error) {
  const msg = String(error?.message || "");
  const isUnknown =
    error?.code === "ER_BAD_FIELD_ERROR" || /Unknown column/i.test(msg);
  if (!isUnknown) return false;
  return ORDER_ATTRIBUTION_KEYS.some((key) => msg.includes(key));
}
