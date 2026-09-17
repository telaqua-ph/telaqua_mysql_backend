/**
 * The Orders-list confirmation label is intentionally independent of payment
 * and shipment progress.  Do not use tracking, waybill, or fulfillment fields
 * here: shipment updates must not change whether an order is confirmed.
 */
const CONFIRMED_ORDER_STATUSES = new Set([
  "confirmed",
  "processing",
  "ready to ship",
  "ready_to_ship",
  "ready to pickup",
  "ready_to_pickup",
  "shipped",
  "in transit",
  "in_transit",
  "out for delivery",
  "out_for_delivery",
  "delivered",
  "completed",
  "fulfilled",
]);

const NEW_ORDER_STATUSES = new Set(["", "new", "pending"]);

/**
 * Derive the two-state display label without changing the persisted lifecycle
 * status. Legacy fulfillment-like order statuses are known post-confirmation
 * states. Other unrecognised/exceptional values are not promoted to Confirmed;
 * a successful payment is the only additional confirmation proof.
 */
export function deriveOrderConfirmationStatus(order) {
  const orderStatus = String(order?.order_status || order?.status || "")
    .trim()
    .toLowerCase();

  if (CONFIRMED_ORDER_STATUSES.has(orderStatus)) return "Confirmed";
  if (NEW_ORDER_STATUSES.has(orderStatus)) return "New";

  return String(order?.payment_status || order?.paymentStatus || "")
    .trim()
    .toLowerCase() === "paid"
    ? "Confirmed"
    : "New";
}

// Kept as an export alias for callers during the API transition.
export const deriveOrderDisplayStatus = deriveOrderConfirmationStatus;
