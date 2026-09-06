-- Optional first-touch attribution on orders (idempotent).
-- Prepare only — do not run automatically against production.
-- Hostinger MySQL: ADD COLUMN IF NOT EXISTS (same style as add_whatsapp_consent.sql).

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS utm_source VARCHAR(255) NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS utm_medium VARCHAR(255) NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(255) NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS utm_term VARCHAR(255) NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS utm_content VARCHAR(255) NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS gclid VARCHAR(255) NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fbclid VARCHAR(255) NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fbp VARCHAR(255) NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fbc VARCHAR(255) NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS landing_url VARCHAR(2048) NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS first_seen_at DATETIME NULL;
