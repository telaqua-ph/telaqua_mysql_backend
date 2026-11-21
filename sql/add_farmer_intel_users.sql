-- Separate logins for the Farmer Intel Map (second lock inside the admin).
-- The backend also creates this table automatically on the first Farmer Intel login.
CREATE TABLE IF NOT EXISTS farmer_intel_users (
  id INT NOT NULL AUTO_INCREMENT,
  full_name VARCHAR(120) NULL,
  email VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  can_view_customer_data TINYINT(1) NOT NULL DEFAULT 0,
  can_manage_couriers TINYINT(1) NOT NULL DEFAULT 0,
  last_login DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_farmer_intel_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
