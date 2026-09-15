-- Tel-Aqua admin Web Push for new orders (additive only).
-- Prepare only — do not run automatically against production.
-- Does not alter the orders table or order-placement transactions.

CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id INT NOT NULL,
  endpoint VARCHAR(512) NOT NULL,
  p256dh VARCHAR(255) NOT NULL,
  auth VARCHAR(255) NOT NULL,
  user_agent VARCHAR(512) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_push_endpoint (endpoint),
  KEY idx_admin_push_admin (admin_id),
  CONSTRAINT fk_admin_push_admin
    FOREIGN KEY (admin_id) REFERENCES admins (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_push_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id INT NOT NULL,
  order_number VARCHAR(64) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  payment_mode VARCHAR(32) NULL,
  payment_status VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_push_order (order_id),
  KEY idx_order_push_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_push_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  notification_id BIGINT UNSIGNED NOT NULL,
  subscription_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending', 'claimed', 'sent', 'failed', 'gone') NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMP NULL,
  claimed_at TIMESTAMP NULL,
  claim_token CHAR(36) NULL,
  last_error VARCHAR(500) NULL,
  sent_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_push_delivery (notification_id, subscription_id),
  KEY idx_order_push_delivery_due (status, next_attempt_at, id),
  KEY idx_order_push_delivery_sub (subscription_id),
  CONSTRAINT fk_order_push_delivery_notification
    FOREIGN KEY (notification_id) REFERENCES order_push_notifications (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_order_push_delivery_subscription
    FOREIGN KEY (subscription_id) REFERENCES admin_push_subscriptions (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_push_worker_state (
  id TINYINT UNSIGNED NOT NULL,
  baseline_order_id INT NOT NULL DEFAULT 0,
  high_watermark_id INT NOT NULL DEFAULT 0,
  high_watermark_created_at DATETIME NOT NULL,
  lookback_seconds INT UNSIGNED NOT NULL DEFAULT 120,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
