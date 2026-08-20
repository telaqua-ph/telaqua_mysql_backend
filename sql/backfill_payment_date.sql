-- Optional: fill payment_date for older paid orders so period filters match.
-- Safe to run more than once.

UPDATE orders
SET payment_date = created_at
WHERE payment_status = 'Paid'
  AND payment_date IS NULL;
