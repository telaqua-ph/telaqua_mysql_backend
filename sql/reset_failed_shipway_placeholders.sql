-- Safely release only the two known failed Shipway placeholders for a retry.
-- This does not delete orders or shipment rows, and excludes all real/Delhivery shipments.
UPDATE shipments AS s
INNER JOIN orders AS o ON o.id = s.order_id
SET s.provider = 'Shipway',
    s.courier_name = 'Shipway',
    s.carrier_id = NULL,
    s.waybill_number = NULL,
    s.shipment_id = NULL,
    s.fulfillment_status = 'unfulfilled',
    s.shipment_status = 'Booking Failed',
    s.shipment_created_at = NULL,
    s.shipping_label_url = NULL,
    s.label_status = 'Failed',
    s.label_generated_at = NULL,
    s.processing_token = NULL,
    s.processing_started_at = NULL,
    s.last_error = COALESCE(s.last_error, 'Shipway booking failed before an AWB or label was created.'),
    s.last_error_at = COALESCE(s.last_error_at, NOW())
WHERE o.order_number IN ('TAQ-000875', 'TAQ-000877')
  AND COALESCE(LOWER(s.provider), '') <> 'delhivery'
  AND COALESCE(LOWER(s.courier_name), '') <> 'delhivery'
  AND NULLIF(TRIM(COALESCE(s.waybill_number, '')), '') IS NULL
  AND NULLIF(TRIM(COALESCE(s.shipment_id, '')), '') IS NULL
  AND NULLIF(TRIM(COALESCE(s.shipping_label_url, '')), '') IS NULL
  AND s.shipment_created_at IS NULL
  AND s.label_generated_at IS NULL
  AND s.pickup_requested_at IS NULL;
