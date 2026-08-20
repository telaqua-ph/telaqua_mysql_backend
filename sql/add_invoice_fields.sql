-- Invoice + WhatsApp invoice columns (already present on production Neon).
-- Safe to run multiple times.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_generated_at TIMESTAMP NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_status VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS swipe_invoice_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS swipe_invoice_error TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_processing_started_at TIMESTAMP NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_attempt_token UUID NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS whatsapp_invoice_status VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS whatsapp_invoice_message_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS whatsapp_invoice_sent_at TIMESTAMP NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS whatsapp_invoice_error TEXT;

-- Immutable checkout totals used for Razorpay verification and Swipe invoices.
-- Existing total_amount remains the final amount for backwards compatibility.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS gst_rate NUMERIC(5,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_amount NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS final_total NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_access_token_hash CHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_swipe_invoice_id
  ON orders (swipe_invoice_id)
  WHERE swipe_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_razorpay_payment_id
  ON orders (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
