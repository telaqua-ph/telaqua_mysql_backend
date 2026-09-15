/**
 * VAPID / Web Push configuration (server-only private key).
 */

import webpush from "web-push";

let configured = false;

export function getVapidPublicKey() {
  return String(process.env.WEB_PUSH_VAPID_PUBLIC_KEY || "").trim();
}

export function getVapidPrivateKey() {
  return String(process.env.WEB_PUSH_VAPID_PRIVATE_KEY || "").trim();
}

export function getVapidSubject() {
  const subject = String(process.env.WEB_PUSH_VAPID_SUBJECT || "").trim();
  return subject || "mailto:admin@telaqua.com";
}

export function isWebPushConfigured() {
  return Boolean(getVapidPublicKey() && getVapidPrivateKey());
}

export function isOrderPushEnabled() {
  const flag = String(process.env.ORDER_PUSH_ENABLED || "true").toLowerCase();
  if (flag === "false" || flag === "0" || flag === "off") return false;
  return isWebPushConfigured();
}

/**
 * Configure web-push once. Never logs private key material.
 */
export function ensureWebPushConfigured() {
  if (configured) return true;
  if (!isWebPushConfigured()) return false;
  webpush.setVapidDetails(
    getVapidSubject(),
    getVapidPublicKey(),
    getVapidPrivateKey()
  );
  configured = true;
  return true;
}

/**
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {object|string} payload
 * @param {object} [options]
 */
export async function sendWebPush(subscription, payload, options = {}) {
  if (!ensureWebPushConfigured()) {
    const err = new Error("Web Push is not configured");
    err.statusCode = 503;
    throw err;
  }
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return webpush.sendNotification(subscription, body, {
    TTL: 60 * 60 * 12,
    urgency: "high",
    ...options,
  });
}

/** Truncate endpoint for safe logs (no keys). */
export function safeEndpointHint(endpoint) {
  const s = String(endpoint || "");
  if (s.length <= 48) return s;
  return `${s.slice(0, 24)}…${s.slice(-16)}`;
}

export function resetWebPushConfigForTests() {
  configured = false;
}
