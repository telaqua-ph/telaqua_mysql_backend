export const COURIER_PROVIDERS = Object.freeze({
  delhivery: "Delhivery",
  indiapost: "IndiaPost",
  shipway: "Shipway",
});

export function normalizeCourierAssignment(input = {}) {
  const providerKey = String(input.provider || "").trim().toLowerCase().replace(/[ _-]/g, "");
  const provider = COURIER_PROVIDERS[providerKey];
  if (!provider) throw Object.assign(new Error("Courier must be Delhivery, India Post, or Shipway."), { httpStatus: 422 });
  const carrierName = String(input.carrier_name ?? input.courier_name ?? "").trim().slice(0, 80);
  const carrierId = String(input.carrier_id ?? "").trim().slice(0, 80) || null;
  // Shipway is an aggregator. Its actual carrier is optional before booking,
  // but must be separately recorded once Shipway assigns one.
  if (provider !== "Shipway" && carrierName && carrierName.toLowerCase() !== provider.toLowerCase()) {
    throw Object.assign(new Error("Direct courier assignments must use their matching carrier name."), { httpStatus: 422 });
  }
  return {
    provider,
    carrierName: provider === "Shipway" ? (carrierName || "Shipway") : provider === "IndiaPost" ? "India Post" : "Delhivery",
    carrierId,
  };
}

export function hasCourierAssignment(shipment) {
  return Boolean(String(shipment?.provider || "").trim() || String(shipment?.courier_name || "").trim());
}
