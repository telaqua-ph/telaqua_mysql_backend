-- Audit trail for admin corrections to an order's delivery details (idempotent).
-- The API also creates this table on first use; this file is for manual setup.
CREATE TABLE IF NOT EXISTS order_delivery_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NOT NULL,
  shipment_id BIGINT UNSIGNED NULL,
  admin_id INT NULL,
  admin_email VARCHAR(255) NULL,
  action VARCHAR(40) NOT NULL,
  shipment_stage VARCHAR(40) NULL,
  waybill VARCHAR(40) NULL,
  changed_fields JSON NULL,
  before_data JSON NULL,
  after_data JSON NULL,
  courier_status VARCHAR(20) NOT NULL,
  courier_message VARCHAR(1000) NULL,
  courier_request JSON NULL,
  courier_response JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_order_delivery_audit_order (order_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
