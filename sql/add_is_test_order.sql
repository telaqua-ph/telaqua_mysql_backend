-- Isolate ₹1 Razorpay LIVE test orders from normal PH meter orders.
-- Safe to run multiple times.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS is_test_order BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_orders_is_test_order
  ON orders (is_test_order)
  WHERE is_test_order = TRUE;
