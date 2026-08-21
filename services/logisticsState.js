export const FULFILLMENT_STATUSES = Object.freeze([
  "unfulfilled",
  "ready_to_ship",
  "shipment_created",
  "pickup_requested",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delivery_failed",
  "pickup_failed",
  "ndr",
  "rto",
  "cancelled",
  "returned",
]);

const TERMINAL = new Set(["delivered", "cancelled", "returned"]);

const RANK = new Map([
  ["unfulfilled", 0], ["ready_to_ship", 1], ["shipment_created", 2],
  ["pickup_requested", 3], ["picked_up", 4], ["in_transit", 5],
  ["out_for_delivery", 6], ["delivered", 7],
]);

export function isTerminalFulfillmentStatus(status) {
  return TERMINAL.has(String(status || "").toLowerCase());
}

export function mapDelhiveryStatus(status, statusCode = "") {
  const value = `${status || ""} ${statusCode || ""}`.toLowerCase();
  if (/rto delivered|returned|return delivered/.test(value)) return "returned";
  if (/delivered|eod-38/.test(value)) return "delivered";
  if (/\brto\b|return to origin/.test(value)) return "rto";
  if (/cancel/.test(value)) return "cancelled";
  if (/pickup failed|pickup exception/.test(value)) return "pickup_failed";
  if (/ndr|undelivered|not delivered|consignee unavailable|address issue/.test(value)) return "ndr";
  if (/out for delivery|dispatched for delivery/.test(value)) return "out_for_delivery";
  if (/in transit|transit|bagged|connected/.test(value)) return "in_transit";
  if (/picked up|pickup complete|collected/.test(value)) return "picked_up";
  if (/pickup request|pickup scheduled/.test(value)) return "pickup_requested";
  if (/failed|damaged|lost/.test(value)) return "delivery_failed";
  if (/created|pending|not picked|manifested|ready for pickup/.test(value)) return "shipment_created";
  return null;
}

export function canAdvanceFulfillment(current, next) {
  const from = String(current || "unfulfilled").toLowerCase();
  const to = String(next || "").toLowerCase();
  if (!FULFILLMENT_STATUSES.includes(to)) return false;
  if (from === to) return true;
  if (isTerminalFulfillmentStatus(from)) return false;
  if (["ndr", "rto", "delivery_failed", "pickup_failed", "cancelled", "returned"].includes(to)) return true;
  if (["ndr", "rto", "delivery_failed", "pickup_failed"].includes(from)) return true;
  return (RANK.get(to) ?? -1) >= (RANK.get(from) ?? 0);
}

export function extractTrackingEvents(payload) {
  const shipmentData = Array.isArray(payload?.ShipmentData) ? payload.ShipmentData : [];
  const shipment = shipmentData[0]?.Shipment || shipmentData[0] || payload?.Shipment || payload;
  const scans = Array.isArray(shipment?.Scans) ? shipment.Scans : [];
  return scans.map((entry) => {
    const scan = entry?.ScanDetail || entry || {};
    return {
      status: String(scan.Scan || scan.Status || scan.status || "Unknown").trim(),
      statusCode: String(scan.StatusCode || scan.status_code || "").trim(),
      location: String(scan.ScannedLocation || scan.location || "").trim() || null,
      eventTime: scan.ScanDateTime || scan.scan_date_time || scan.timestamp || null,
      instructions: String(scan.Instructions || scan.instructions || "").trim() || null,
      raw: scan,
    };
  }).filter((event) => event.status);
}
