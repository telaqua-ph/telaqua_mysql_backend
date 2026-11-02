/**
 * Shipments booked through Shipway or India Post are managed there.
 * Delhivery-only operations (tracking, pickup, waybill, update, NDR, webhooks)
 * must never touch them. Rows without a provider are legacy Delhivery shipments.
 */

export const DELHIVERY_ONLY_SQL = "(provider IS NULL OR LOWER(TRIM(provider)) NOT IN ('shipway', 'indiapost'))";

export function isShipwayShipment(shipment) {
  return String(shipment?.provider ?? "").trim().toLowerCase() === "shipway";
}

export function isIndiaPostProvider(shipment) {
  return String(shipment?.provider ?? "").trim().toLowerCase().replace(/[\s_-]/g, "") === "indiapost";
}

export function assertDelhiveryManagedShipment(shipment) {
  const managedBy = isShipwayShipment(shipment) ? "Shipway" : isIndiaPostProvider(shipment) ? "India Post" : null;
  if (!managedBy) return;
  const message = `This shipment is managed by ${managedBy}; Delhivery operations are not available for it.`;
  throw Object.assign(new Error(message), {
    code: managedBy === "Shipway" ? "SHIPWAY_MANAGED_SHIPMENT" : "INDIA_POST_MANAGED_SHIPMENT",
    httpStatus: 409,
    publicMessage: message,
  });
}
