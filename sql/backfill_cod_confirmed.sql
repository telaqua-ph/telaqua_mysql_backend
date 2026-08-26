-- Optional: existing website/admin COD still New + Pending → Confirmed.
-- Does not change payment_status. Does not touch unpaid Razorpay (stays New).
-- Safe to run more than once.

UPDATE orders
SET order_status = 'Confirmed'
WHERE order_status = 'New'
  AND payment_status = 'Pending'
  AND (
    LOWER(TRIM(COALESCE(payment_mode, ''))) = 'cod'
    OR (
      LOWER(TRIM(COALESCE(payment_mode, ''))) NOT IN ('cod', 'razorpay')
      AND LOWER(TRIM(COALESCE(payment_method, ''))) IN (
        'cod',
        'cash on delivery',
        'cash_on_delivery'
      )
    )
  );
