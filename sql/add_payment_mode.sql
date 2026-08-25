-- Additive payment_mode on live Hostinger `orders`.
-- Safe to run more than once (migrate script skips if the column exists).
-- Does not drop, recreate, or rewrite Razorpay payment data.

ALTER TABLE orders
  ADD COLUMN payment_mode ENUM('razorpay', 'cod') NOT NULL DEFAULT 'razorpay';

-- Existing rows inherit DEFAULT 'razorpay'. Reclassify only reliable COD methods.
UPDATE orders
SET payment_mode = 'cod'
WHERE LOWER(TRIM(payment_method)) IN ('cod', 'cash on delivery', 'cash_on_delivery');
