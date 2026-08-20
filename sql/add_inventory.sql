-- Inventory management for Tel-Aqua single product (telaqua-ph-meter).
-- Run once against Neon/PostgreSQL before deploying inventory features.

CREATE TABLE IF NOT EXISTS inventory (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(64) NOT NULL UNIQUE,
  product_name VARCHAR(255) NOT NULL,
  current_stock INTEGER NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 10 CHECK (low_stock_threshold >= 0),
  low_stock_alert_active BOOLEAN NOT NULL DEFAULT FALSE,
  out_of_stock_alert_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_history (
  id SERIAL PRIMARY KEY,
  inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  sku VARCHAR(64) NOT NULL,
  quantity_change INTEGER NOT NULL CHECK (quantity_change <> 0),
  transaction_type VARCHAR(32) NOT NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  order_number VARCHAR(32),
  reason TEXT,
  previous_stock INTEGER NOT NULL CHECK (previous_stock >= 0),
  new_stock INTEGER NOT NULL CHECK (new_stock >= 0),
  admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT inventory_history_type_check CHECK (
    transaction_type IN (
      'STOCK_ADDED',
      'SALE',
      'RETURN',
      'CANCELLATION',
      'ADJUSTMENT',
      'DAMAGED'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_history_order_sale_unique
  ON inventory_history (order_id, transaction_type)
  WHERE order_id IS NOT NULL
    AND transaction_type IN ('SALE', 'CANCELLATION', 'RETURN');

CREATE TABLE IF NOT EXISTS admin_notifications (
  id SERIAL PRIMARY KEY,
  notification_type VARCHAR(32) NOT NULL,
  inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  sku VARCHAR(64) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  stock_at_notification INTEGER NOT NULL CHECK (stock_at_notification >= 0),
  threshold INTEGER,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT admin_notifications_type_check CHECK (
    notification_type IN ('LOW_STOCK', 'OUT_OF_STOCK')
  )
);

CREATE INDEX IF NOT EXISTS admin_notifications_unread_idx
  ON admin_notifications (is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_history_created_idx
  ON inventory_history (created_at DESC);

-- Seed default product row (adjust initial stock before go-live).
INSERT INTO inventory (sku, product_name, current_stock, low_stock_threshold)
VALUES ('telaqua-ph-meter', 'Tel-Aqua pH Meter', 100, 10)
ON CONFLICT (sku) DO NOTHING;
