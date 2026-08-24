import { mapDelhiveryStatus } from "./logisticsState.js";

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

/**
 * Derive the admin Orders-table status from persisted order and Delhivery data.
 * Tracking-derived states intentionally use only the stored tracking status/code.
 */
export function deriveOrderDisplayStatus(order) {
  if (String(order?.payment_status || "").trim().toLowerCase() !== "paid") {
    return null;
  }

  const trackingStatus = String(order?.tracking_status || "").trim();
  const trackingCode = String(
    order?.shipment_status_code || order?.tracking_status_code || ""
  ).trim();
  const trackedState = mapDelhiveryStatus(trackingStatus, trackingCode);
  const explicitlyUndelivered = /undelivered|not delivered/i.test(trackingStatus);

  if (trackedState === "delivered" && !explicitlyUndelivered) return "DELIVERED";
  if (trackedState === "out_for_delivery") return "OUT_FOR_DELIVERY";
  if (trackedState === "picked_up" || trackedState === "in_transit") {
    return "IN_TRANSIT";
  }

  const shipmentExists = [
    order?.waybill,
    order?.delhivery_shipment_id,
    order?.shipment_created_at,
  ].some(hasValue);

  return shipmentExists ? "READY_TO_PICKUP" : "READY_TO_SHIP";
}
