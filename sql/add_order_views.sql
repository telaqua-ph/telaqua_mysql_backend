-- Track which admin users have viewed which orders.
-- Run once against Neon/PostgreSQL before deploying unseen-order features.

CREATE TABLE IF NOT EXISTS admin_order_views (
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  first_viewed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_viewed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (admin_id, order_id)
);

CREATE INDEX IF NOT EXISTS admin_order_views_order_idx
  ON admin_order_views (order_id);

CREATE INDEX IF NOT EXISTS admin_order_views_last_viewed_idx
  ON admin_order_views (last_viewed_at DESC);
