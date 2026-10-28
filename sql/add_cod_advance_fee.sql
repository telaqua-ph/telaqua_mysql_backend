-- ₹99 non-refundable advance delivery fee for website COD orders (additive).
-- Run via: node scripts/migrate-cod-advance-fee.js (skips columns that already exist).
-- Existing orders are untouched: all new order columns are NULL for them.

-- One row per COD checkout attempt. The order is created only after the ₹99
-- Razorpay payment is verified; order_id links the attempt to that order.
CREATE TABLE IF NOT EXISTS cod_advance_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  razorpay_order_id VARCHAR(64) NULL,
  razorpay_payment_id VARCHAR(64) NULL,
  amount_paise INT UNSIGNED NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'created',
  checkout_payload JSON NOT NULL,
  product_amount DECIMAL(10,2) NOT NULL,
  declaration_accepted_at DATETIME NOT NULL,
  order_id BIGINT UNSIGNED NULL,
  failure_reason VARCHAR(500) NULL,
  verified_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cod_advance_rz_order (razorpay_order_id),
  UNIQUE KEY uq_cod_advance_rz_payment (razorpay_payment_id),
  UNIQUE KEY uq_cod_advance_order (order_id),
  KEY idx_cod_advance_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE orders ADD COLUMN cod_advance_fee DECIMAL(10,2) NULL;
ALTER TABLE orders ADD COLUMN cod_advance_status VARCHAR(20) NULL;
ALTER TABLE orders ADD COLUMN cod_advance_razorpay_order_id VARCHAR(64) NULL;
ALTER TABLE orders ADD COLUMN cod_advance_razorpay_payment_id VARCHAR(64) NULL;
ALTER TABLE orders ADD COLUMN cod_advance_verified_at DATETIME NULL;
ALTER TABLE orders ADD COLUMN cod_amount_due DECIMAL(10,2) NULL;
ALTER TABLE orders ADD COLUMN cod_fee_declaration_accepted_at DATETIME NULL;
