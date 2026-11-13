-- Run in Hostinger phpMyAdmin with the production database selected.
-- SELECT only: no order, payment, source, invoice or shipment data is changed.
-- Export the result as CSV to review every order, including historical markers.
-- Review findings against source records before making any correction.
-- Timestamp boundary follows the existing Offline Sold section's entry cutoff.

SELECT
  id, order_number, created_at, order_channel, offline_sold, purchased_on,
  payment_status, payment_method, payment_mode, quantity,
  total_amount, final_total, cod_advance_status, cod_advance_fee, cod_amount_due,
  CASE
    WHEN LOWER(TRIM(COALESCE(offline_sold, ''))) IN ('cod paid-cash', 'cod paid-qr')
      AND created_at >= '2026-11-07 08:23:00'
      AND LOWER(TRIM(COALESCE(payment_status, ''))) = 'paid'
      AND LOWER(TRIM(COALESCE(NULLIF(TRIM(payment_mode), ''), payment_method, ''))) = 'cod'
      AND LOWER(TRIM(COALESCE(order_channel, ''))) IN ('', 'admin')
      AND COALESCE(cod_advance_razorpay_payment_id, '') = ''
    THEN 'Offline Sold'
    ELSE 'Regular Order'
  END AS sale_classification,
  CONCAT_WS('; ',
    CASE WHEN quantity IS NULL OR quantity <= 0 OR quantity <> FLOOR(quantity)
      THEN 'INVALID_QUANTITY' END,
    CASE WHEN COALESCE(final_total, total_amount) IS NULL OR COALESCE(final_total, total_amount) < 0
      THEN 'INVALID_TOTAL' END,
    CASE WHEN final_total IS NOT NULL AND total_amount IS NOT NULL
      AND ABS(final_total - total_amount) > 0.01
      THEN 'TOTAL_FIELDS_DIFFER' END,
    CASE WHEN (LOWER(TRIM(payment_mode)) = 'razorpay' AND LOWER(TRIM(payment_method)) = 'cod')
      OR (LOWER(TRIM(payment_mode)) = 'cod' AND LOWER(TRIM(payment_method)) = 'razorpay')
      THEN 'PAYMENT_MODE_METHOD_CONFLICT' END,
    CASE WHEN COALESCE(offline_sold, '') <> '' AND created_at < '2026-11-07 08:23:00'
      THEN 'LEGACY_OFFLINE_MARKER_OUTSIDE_OFFLINE_LIST' END,
    CASE WHEN COALESCE(offline_sold, '') <> '' AND created_at IS NULL
      THEN 'OFFLINE_MARKER_WITHOUT_ENTRY_DATE' END,
    CASE WHEN COALESCE(offline_sold, '') <> ''
      AND LOWER(TRIM(offline_sold)) NOT IN ('cod paid-cash', 'cod paid-qr')
      THEN 'UNKNOWN_OR_LEGACY_OFFLINE_TYPE' END,
    CASE WHEN COALESCE(offline_sold, '') <> ''
      AND LOWER(TRIM(COALESCE(NULLIF(TRIM(payment_mode), ''), payment_method, ''))) <> 'cod'
      THEN 'OFFLINE_MARKER_WITH_NON_COD_PAYMENT' END,
    CASE WHEN COALESCE(offline_sold, '') <> '' AND LOWER(TRIM(COALESCE(payment_status, ''))) <> 'paid'
      THEN 'OFFLINE_MARKER_WITHOUT_PAID_STATUS' END,
    CASE WHEN COALESCE(offline_sold, '') <> '' AND LOWER(TRIM(COALESCE(order_channel, ''))) <> 'admin'
      THEN 'OFFLINE_MARKER_WITHOUT_ADMIN_SOURCE' END,
    CASE WHEN COALESCE(offline_sold, '') <> '' AND COALESCE(cod_advance_razorpay_payment_id, '') <> ''
      THEN 'OFFLINE_MARKER_WITH_WEBSITE_COD_ADVANCE' END,
    CASE WHEN LOWER(TRIM(COALESCE(cod_advance_status, ''))) = 'paid'
      AND (cod_advance_fee IS NULL OR cod_advance_fee <= 0)
      THEN 'INVALID_PAID_ADVANCE' END,
    CASE WHEN LOWER(TRIM(COALESCE(cod_advance_status, ''))) = 'paid'
      AND (cod_amount_due IS NULL OR cod_amount_due < 0)
      THEN 'INVALID_COD_BALANCE' END,
    CASE WHEN LOWER(TRIM(COALESCE(cod_advance_status, ''))) = 'paid'
      AND ABS(cod_advance_fee + cod_amount_due - COALESCE(final_total, total_amount)) > 0.01
      AND NOT (ABS(cod_advance_fee - 99) < 0.01
        AND ABS(cod_amount_due - COALESCE(final_total, total_amount)) < 0.01)
      THEN 'ADVANCE_AND_BALANCE_DO_NOT_MATCH_TOTAL' END,
    CASE WHEN LOWER(TRIM(COALESCE(cod_advance_status, ''))) = 'paid'
      AND COALESCE(cod_advance_razorpay_payment_id, '') = ''
      THEN 'PAID_ADVANCE_WITHOUT_PAYMENT_REFERENCE' END
  ) AS review_findings
FROM orders
ORDER BY id;
