/**
 * Pure helpers for admin Web Push notification copy and URL safety.
 * No I/O — safe for isolated unit tests.
 */

/**
 * Format INR amount for notification body (no customer PII).
 * @param {unknown} amount
 * @returns {string}
 */
export function formatOrderPushAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "₹—";
  const rounded = Math.round(n * 100) / 100;
  const formatted = rounded.toLocaleString("en-IN", {
    minimumFractionDigits: rounded % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `₹${formatted}`;
}

/**
 * Accurate payment mode + status wording.
 * Never describes pending Razorpay / online payment as paid.
 *
 * @param {{ payment_mode?: string|null, payment_status?: string|null, payment_method?: string|null }} order
 * @returns {string}
 */
export function formatPaymentWording(order) {
  const modeRaw = String(order?.payment_mode || order?.payment_method || "")
    .trim()
    .toLowerCase();
  const statusRaw = String(order?.payment_status || "").trim().toLowerCase();

  const isCod = modeRaw === "cod" || modeRaw === "cash on delivery";
  const modeLabel = isCod ? "COD" : "Online";

  if (statusRaw === "paid") {
    return `${modeLabel} · Paid`;
  }
  if (statusRaw === "failed") {
    return `${modeLabel} · Payment failed`;
  }
  if (statusRaw === "refunded") {
    return `${modeLabel} · Refunded`;
  }
  // Pending or unknown — never say "Paid"
  return `${modeLabel} · Payment pending`;
}

/**
 * Build notification title/body/tag/url for a saved order.
 * Excludes phone numbers and addresses.
 *
 * @param {{
 *   id: number|string,
 *   order_number?: string|null,
 *   amount?: number|string|null,
 *   payment_mode?: string|null,
 *   payment_status?: string|null,
 *   payment_method?: string|null,
 * }} order
 */
export function buildOrderPushPayload(order) {
  const orderId = Number(order?.id);
  const orderNumber = String(order?.order_number || orderId || "").trim() || String(orderId);
  const amountText = formatOrderPushAmount(order?.amount);
  const paymentText = formatPaymentWording(order);
  const url = Number.isFinite(orderId) && orderId > 0 ? `/orders/${orderId}` : "/orders";

  return {
    title: "New order received",
    body: `Order ${orderNumber} · ${amountText} · ${paymentText}`,
    tag: Number.isFinite(orderId) && orderId > 0 ? `telaqua-order-${orderId}` : "telaqua-order",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    orderId: Number.isFinite(orderId) && orderId > 0 ? orderId : null,
    url,
  };
}

/**
 * Only allow safe same-origin admin paths (orders list or detail).
 * @param {unknown} rawUrl
 * @returns {string|null}
 */
export function sanitizeAdminNotificationUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) return null;
  if (url === "/orders") return "/orders";
  if (/^\/orders\/\d+$/.test(url)) return url;
  return null;
}

/**
 * Backoff seconds after N completed attempts (1-based after increment).
 * @param {number} attempts
 * @returns {number|null} null = stop retrying
 */
export function deliveryBackoffSeconds(attempts) {
  const n = Number(attempts);
  if (!Number.isFinite(n) || n < 1) return 30;
  if (n >= 5) return null;
  const table = [30, 120, 600, 1800];
  return table[Math.min(n - 1, table.length - 1)];
}

export const ORDER_PUSH_MAX_ATTEMPTS = 5;

/**
 * Push-service responses that mean the subscription is gone.
 * @param {unknown} statusCode
 */
export function isExpiredPushStatus(statusCode) {
  const code = Number(statusCode);
  return code === 404 || code === 410;
}

/**
 * Decide whether an order id is eligible given durable baseline/watermark.
 * Used by tests and documented in worker comments.
 *
 * @param {{ id: number, created_at: Date|string }} order
 * @param {{
 *   baselineOrderId: number,
 *   highWatermarkId: number,
 *   highWatermarkCreatedAt: Date|string,
 *   lookbackSeconds: number,
 * }} state
 * @param {Set<number>|number[]} alreadyNotifiedOrderIds
 */
export function isOrderEligibleForScan(order, state, alreadyNotifiedOrderIds) {
  const id = Number(order?.id);
  if (!Number.isFinite(id) || id <= 0) return false;

  const notified =
    alreadyNotifiedOrderIds instanceof Set
      ? alreadyNotifiedOrderIds
      : new Set(alreadyNotifiedOrderIds || []);
  if (notified.has(id)) return false;

  const baseline = Number(state.baselineOrderId) || 0;
  if (id <= baseline) return false;

  const watermarkId = Number(state.highWatermarkId) || 0;
  if (id > watermarkId) return true;

  const lookbackMs = Math.max(0, Number(state.lookbackSeconds) || 0) * 1000;
  const watermarkAt = new Date(state.highWatermarkCreatedAt).getTime();
  const createdAt = new Date(order.created_at).getTime();
  if (!Number.isFinite(watermarkAt) || !Number.isFinite(createdAt)) return false;
  return createdAt >= watermarkAt - lookbackMs;
}

/**
 * Advance watermark after a scan batch (includes already-seen rows).
 */
export function nextWatermark(state, scannedOrders) {
  let highId = Number(state.highWatermarkId) || 0;
  let highAt = new Date(state.highWatermarkCreatedAt);
  if (Number.isNaN(highAt.getTime())) highAt = new Date(0);

  for (const order of scannedOrders || []) {
    const id = Number(order.id);
    const created = new Date(order.created_at);
    if (Number.isFinite(id) && id > highId) highId = id;
    if (!Number.isNaN(created.getTime()) && created > highAt) highAt = created;
  }

  return {
    highWatermarkId: highId,
    highWatermarkCreatedAt: highAt,
  };
}
