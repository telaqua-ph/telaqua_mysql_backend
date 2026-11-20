-- Additive Farmer Intel Map data and permission model. No production rows are changed.
CREATE TABLE IF NOT EXISTS admin_permissions (
  admin_id INT NOT NULL,
  can_view_farmer_intel_map TINYINT(1) NOT NULL DEFAULT 0,
  can_view_customer_data TINYINT(1) NOT NULL DEFAULT 0,
  can_manage_couriers TINYINT(1) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (admin_id),
  CONSTRAINT fk_admin_permissions_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Coordinates represent a pincode centroid only; never a customer's exact location.
CREATE TABLE IF NOT EXISTS pincode_geocodes (
  pincode VARCHAR(10) NOT NULL,
  district VARCHAR(120) NULL,
  state VARCHAR(120) NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  source_name VARCHAR(160) NOT NULL,
  source_updated_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (pincode),
  KEY idx_pincode_geocodes_district (district, state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_orders_farmer_intel_created ON orders (created_at, is_test_order);
CREATE INDEX idx_shipments_farmer_intel_order_status ON shipments (order_id, fulfillment_status, sequence_no);
