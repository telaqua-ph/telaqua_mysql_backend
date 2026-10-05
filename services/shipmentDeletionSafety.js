const value = (input) => String(input ?? "").trim();

/** Only an unbooked non-Delhivery placeholder may be removed with its order. */
export function isSafeFailedShipmentPlaceholder(shipment) {
  const provider = value(shipment?.provider).toLowerCase();
  const courier = value(shipment?.courier_name).toLowerCase();
  if (provider === "delhivery" || courier === "delhivery") return false;
  return ![
    shipment?.waybill_number, shipment?.shipment_id, shipment?.shipment_created_at,
    shipment?.shipping_label_url, shipment?.label_generated_at, shipment?.pickup_requested_at,
  ].some((item) => value(item));
}
