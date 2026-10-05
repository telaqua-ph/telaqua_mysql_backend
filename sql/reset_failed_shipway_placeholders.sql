-- Release the known failed Shipway placeholders (TAQ-000873/875/877/879) so they can be retried.
-- Shipway rejected these bookings ("carrier_id does not exist." / "No Courier Found."); no AWB or
-- label was ever created. Run only after confirming in Shipway that none of these orders exist.
--
-- Safety: updates only rows whose provider is Shipway; never Delhivery or provider-less rows,
-- never rows with an AWB, shipment_id, label, creation or pickup. No rows are deleted.
UPDATE shipments AS s
INNER JOIN orders AS o ON o.id = s.order_id
SET s.carrier_id = NULL,
    s.fulfillment_status = 'unfulfilled',
    s.shipment_status = 'Booking Failed',
    s.label_status = 'Failed',
    s.processing_token = NULL,
    s.processing_started_at = NULL,
    s.last_error = COALESCE(s.last_error, 'Shipway booking failed before an AWB or label was created.'),
    s.last_error_at = COALESCE(s.last_error_at, NOW())
WHERE o.order_number IN ('TAQ-000873', 'TAQ-000875', 'TAQ-000877', 'TAQ-000879')
  AND s.provider IS NOT NULL
  AND LOWER(TRIM(s.provider)) = 'shipway'
  AND NULLIF(TRIM(COALESCE(s.waybill_number, '')), '') IS NULL
  AND NULLIF(TRIM(COALESCE(s.shipment_id, '')), '') IS NULL
  AND NULLIF(TRIM(COALESCE(s.shipping_label_url, '')), '') IS NULL
  AND s.shipment_created_at IS NULL
  AND s.label_generated_at IS NULL
  AND s.pickup_requested_at IS NULL;

-- Verify: every listed order should show provider Shipway, no AWB, status Booking Failed, no lock.
SELECT o.order_number, s.provider, s.waybill_number, s.shipment_status, s.fulfillment_status, s.processing_token
FROM shipments AS s
INNER JOIN orders AS o ON o.id = s.order_id
WHERE o.order_number IN ('TAQ-000873', 'TAQ-000875', 'TAQ-000877', 'TAQ-000879');
