-- Tel-Aqua Delhivery logistics layer (MySQL 8+).
-- Additive only: no payment/Razorpay columns or existing order data are removed.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fulfillment_status VARCHAR(32) NOT NULL DEFAULT 'unfulfilled';

CREATE INDEX idx_orders_fulfillment_status
  ON orders (fulfillment_status);

CREATE TABLE IF NOT EXISTS logistics_warehouses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  registered_name VARCHAR(160) NULL,
  address VARCHAR(500) NOT NULL,
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100) NOT NULL,
  pincode CHAR(6) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  delhivery_reference VARCHAR(160) NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  raw_response JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_logistics_warehouse_name (name),
  KEY idx_logistics_warehouse_default (is_default, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shipments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id INT NOT NULL,
  sequence_no SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(100) NOT NULL,
  environment ENUM('staging','production') NOT NULL,
  warehouse_id BIGINT UNSIGNED NULL,
  shipment_id VARCHAR(160) NULL,
  waybill_number VARCHAR(40) NULL,
  courier_name VARCHAR(80) NOT NULL DEFAULT 'Delhivery',
  fulfillment_status VARCHAR(32) NOT NULL DEFAULT 'unfulfilled',
  shipment_status VARCHAR(120) NULL,
  shipment_status_code VARCHAR(60) NULL,
  shipment_status_at DATETIME NULL,
  shipment_created_at DATETIME NULL,
  serviceable TINYINT(1) NULL,
  serviceability_message VARCHAR(500) NULL,
  serviceability_checked_at DATETIME NULL,
  pickup_requested_at DATETIME NULL,
  pickup_status VARCHAR(80) NULL,
  pickup_date DATE NULL,
  pickup_location VARCHAR(160) NULL,
  pickup_reference VARCHAR(160) NULL,
  expected_delivery_date DATE NULL,
  estimated_tat VARCHAR(120) NULL,
  tat_checked_at DATETIME NULL,
  shipping_charge DECIMAL(12,2) NULL,
  rate_calculated_at DATETIME NULL,
  shipping_label_url TEXT NULL,
  label_status VARCHAR(80) NULL,
  label_generated_at DATETIME NULL,
  tracking_url TEXT NULL,
  current_location VARCHAR(255) NULL,
  last_tracking_update DATETIME NULL,
  delivered_at DATETIME NULL,
  ndr_status VARCHAR(120) NULL,
  ndr_reason TEXT NULL,
  serviceability_response JSON NULL,
  tat_response JSON NULL,
  rate_response JSON NULL,
  shipment_response JSON NULL,
  tracking_response JSON NULL,
  label_response JSON NULL,
  pickup_response JSON NULL,
  ndr_response JSON NULL,
  last_error TEXT NULL,
  last_error_response JSON NULL,
  last_error_at DATETIME NULL,
  processing_token VARCHAR(80) NULL,
  processing_started_at DATETIME NULL,
  waybill_processing_token CHAR(36) NULL,
  waybill_processing_started_at DATETIME NULL,
  shipment_update_response JSON NULL,
  shipment_updated_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shipments_order_sequence (order_id, sequence_no),
  UNIQUE KEY uq_shipments_idempotency (idempotency_key),
  UNIQUE KEY uq_shipments_waybill (waybill_number),
  KEY idx_shipments_order_id (order_id),
  KEY idx_shipments_status (fulfillment_status),
  KEY idx_shipments_tracking_due (fulfillment_status, last_tracking_update),
  KEY idx_shipments_warehouse (warehouse_id),
  CONSTRAINT fk_shipments_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipments_warehouse FOREIGN KEY (warehouse_id) REFERENCES logistics_warehouses(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Existing installations receive the same additive fields safely.
ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS serviceable TINYINT(1) NULL AFTER shipment_created_at,
  ADD COLUMN IF NOT EXISTS shipment_status_at DATETIME NULL AFTER shipment_status_code,
  ADD COLUMN IF NOT EXISTS serviceability_message VARCHAR(500) NULL AFTER serviceable,
  ADD COLUMN IF NOT EXISTS serviceability_checked_at DATETIME NULL AFTER serviceability_message,
  ADD COLUMN IF NOT EXISTS pickup_status VARCHAR(80) NULL AFTER pickup_requested_at,
  ADD COLUMN IF NOT EXISTS tat_checked_at DATETIME NULL AFTER estimated_tat,
  ADD COLUMN IF NOT EXISTS rate_calculated_at DATETIME NULL AFTER shipping_charge,
  ADD COLUMN IF NOT EXISTS label_status VARCHAR(80) NULL AFTER shipping_label_url,
  ADD COLUMN IF NOT EXISTS label_generated_at DATETIME NULL AFTER label_status,
  ADD COLUMN IF NOT EXISTS current_location VARCHAR(255) NULL AFTER tracking_url,
  ADD COLUMN IF NOT EXISTS last_error_response JSON NULL AFTER last_error,
  ADD COLUMN IF NOT EXISTS last_error_at DATETIME NULL AFTER last_error_response,
  ADD COLUMN IF NOT EXISTS waybill_processing_token CHAR(36) NULL AFTER processing_started_at,
  ADD COLUMN IF NOT EXISTS waybill_processing_started_at DATETIME NULL AFTER waybill_processing_token,
  ADD COLUMN IF NOT EXISTS shipment_update_response JSON NULL AFTER waybill_processing_started_at,
  ADD COLUMN IF NOT EXISTS shipment_updated_at DATETIME NULL AFTER shipment_update_response;

ALTER TABLE shipments
  MODIFY COLUMN processing_token VARCHAR(80) NULL;

CREATE TABLE IF NOT EXISTS shipment_tracking_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shipment_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(160) NOT NULL,
  status_code VARCHAR(60) NULL,
  fulfillment_status VARCHAR(32) NULL,
  location VARCHAR(255) NULL,
  instructions TEXT NULL,
  event_time DATETIME NULL,
  raw_event JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tracking_shipment_time (shipment_id, event_time),
  KEY idx_tracking_status (fulfillment_status),
  CONSTRAINT fk_tracking_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shipment_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shipment_id BIGINT UNSIGNED NOT NULL,
  admin_id INT NULL,
  action VARCHAR(80) NOT NULL,
  before_data JSON NULL,
  after_data JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_shipment_audit (shipment_id, created_at),
  CONSTRAINT fk_audit_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Preserve existing logistics progress when legacy columns are present by running
-- the optional backfill in docs/DELHIVERY_FLOW.md after reviewing the live schema.
