-- Fast2SMS invoice link SMS (idempotent). The backend also adds these on first use.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS sms_invoice_token_hash CHAR(64) NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sms_invoice_status VARCHAR(20) NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sms_invoice_request_id VARCHAR(100) NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sms_invoice_sent_at TIMESTAMP NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sms_invoice_error VARCHAR(500) NULL;
