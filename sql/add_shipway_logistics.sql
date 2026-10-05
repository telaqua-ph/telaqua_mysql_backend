-- Additive Shipway metadata. Existing Delhivery shipment rows remain unchanged.
ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS provider VARCHAR(32) NULL AFTER courier_name,
  ADD COLUMN IF NOT EXISTS carrier_id VARCHAR(80) NULL AFTER provider;

UPDATE shipments
SET provider = 'Delhivery'
WHERE provider IS NULL AND (waybill_number IS NOT NULL OR shipment_id IS NOT NULL OR shipment_created_at IS NOT NULL);
