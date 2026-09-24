import { mapDelhiveryStatus } from "./logisticsState.js";

const LABELS = Object.freeze({
  shipment_created: "Ready to Pickup",
  pickup_requested: "Ready to Pickup",
  picked_up: "Picked Up",
  in_transit: "In Transit",
  out_for_delivery: "Out for Delivery",
  delivered: "Delivered",
  rto: "RTO In-Transit",
  returned: "RTO",
  cancelled: "Cancelled",
  delivery_failed: "Delivery Failed",
  pickup_failed: "Pickup Failed",
  ndr: "Delivery Exception",
});

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

// Delhivery's create-shipment API can acknowledge a successful request with
// `Success`.  That is not a courier scan and must never be presented as one.
function isCreationAcknowledgement(value) {
  return /^(success|created|shipment created)$/i.test(String(value || "").trim());
}

export function deriveShipmentStatusDisplay(order) {
  const trackingStatus = String(order?.tracking_status || "").trim();
  const shipmentStatus = String(order?.shipment_status || "").trim();
  const rawStatus = !isCreationAcknowledgement(trackingStatus)
    ? trackingStatus
    : !isCreationAcknowledgement(shipmentStatus)
      ? shipmentStatus
      : "";
  const statusCode = String(
    order?.shipment_status_code || order?.tracking_status_code || ""
  ).trim();
  const mapped = mapDelhiveryStatus(rawStatus, statusCode);

  if (mapped === "ndr" && /undelivered|not delivered/i.test(rawStatus)) {
    return "Undelivered";
  }
  if (mapped && LABELS[mapped]) return LABELS[mapped];
  if (rawStatus && !/^(not created|unfulfilled)$/i.test(rawStatus)) return rawStatus;

  const paid = String(order?.payment_status || "").trim().toLowerCase() === "paid";
  if (paid && !hasValue(order?.waybill)) return "Pending AWB";
  if (paid && hasValue(order?.waybill)) return "Ready to Pickup";

  const fulfillment = String(order?.fulfillment_status || "").trim().toLowerCase();
  return LABELS[fulfillment] || rawStatus || "Unfulfilled";
}
