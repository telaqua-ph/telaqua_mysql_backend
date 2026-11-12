CREATE TABLE IF NOT EXISTS checkout_leads (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id VARCHAR(100) NOT NULL,
  lead_status ENUM('started','in_progress','abandoned','converted') NOT NULL DEFAULT 'started',
  customer_name VARCHAR(255) NULL, phone VARCHAR(20) NULL, email VARCHAR(255) NULL,
  address TEXT NULL, city VARCHAR(120) NULL, state VARCHAR(120) NULL, pincode VARCHAR(10) NULL,
  product_name VARCHAR(500) NULL, product_id VARCHAR(255) NULL, quantity INT UNSIGNED NULL,
  original_amount DECIMAL(12,2) NULL, discount_amount DECIMAL(12,2) NULL, final_amount DECIMAL(12,2) NULL,
  promo_code VARCHAR(100) NULL, payment_method VARCHAR(40) NULL, checkout_url VARCHAR(500) NULL,
  lead_source VARCHAR(50) NOT NULL DEFAULT 'checkout', payload JSON NOT NULL,
  converted_order_id BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY uq_checkout_leads_session (session_id), KEY idx_checkout_leads_phone (phone),
  KEY idx_checkout_leads_status_activity (lead_status, last_activity_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
