/**
 * payment_mode helpers for Tel-Aqua orders.
 * Razorpay remains the default; COD is explicit.
 */

const COD_METHODS = new Set(["cod", "cash on delivery", "cash_on_delivery"]);

export function normalizePaymentMode(order) {
  const mode = String(order?.payment_mode || "").trim().toLowerCase();
  if (mode === "cod") return "cod";
  if (mode === "razorpay") return "razorpay";

  const method = String(order?.payment_method || "").trim().toLowerCase();
  if (COD_METHODS.has(method)) return "cod";
  return "razorpay";
}

export function isCodOrder(order) {
  return normalizePaymentMode(order) === "cod";
}

export function withNormalizedPaymentMode(order) {
  if (!order) return order;
  return {
    ...order,
    payment_mode: normalizePaymentMode(order),
  };
}

/** COD Pending orders may be fulfilled; Razorpay/prepaid still require Paid. */
export function canFulfillOrder(order) {
  const pay = String(order?.payment_status || "").trim().toLowerCase();
  if (isCodOrder(order)) return pay === "pending" || pay === "paid";
  return pay === "paid";
}
