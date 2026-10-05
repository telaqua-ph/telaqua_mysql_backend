/**
 * Shipments booked through Shipway are managed in Shipway. Delhivery-only
 * operations (tracking, pickup, waybill, update, NDR) must never touch them.
 */

export const DELHIVERY_ONLY_SQL = "(provider IS NULL OR LOWER(TRIM(provider)) <> 'shipway')";

export function isShipwayShipment(shipment) {
  return String(shipment?.provider ?? "").trim().toLowerCase() === "shipway";
}

export function assertDelhiveryManagedShipment(shipment) {
  if (!isShipwayShipment(shipment)) return;
  const message = "This shipment is managed by Shipway; Delhivery operations are not available for it.";
  throw Object.assign(new Error(message), {
    code: "SHIPWAY_MANAGED_SHIPMENT",
    httpStatus: 409,
    publicMessage: message,
  });
}
