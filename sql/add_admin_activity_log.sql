-- Admin Activity Log: who changed what in the admin dashboard.
-- The backend also creates this table automatically on the first logged change.
CREATE TABLE IF NOT EXISTS admin_activity_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  admin_id INT NULL,
  admin_name VARCHAR(150) NULL,
  admin_email VARCHAR(190) NULL,
  action VARCHAR(80) NOT NULL,
  action_label VARCHAR(190) NULL,
  entity_type VARCHAR(40) NULL,
  entity_id VARCHAR(64) NULL,
  order_id INT NULL,
  order_number VARCHAR(40) NULL,
  summary VARCHAR(1000) NULL,
  changes LONGTEXT NULL,
  request_method VARCHAR(10) NULL,
  request_path VARCHAR(255) NULL,
  request_body TEXT NULL,
  status_code INT NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_aal_created (created_at),
  KEY idx_aal_admin (admin_id, created_at),
  KEY idx_aal_order (order_id, created_at),
  KEY idx_aal_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
