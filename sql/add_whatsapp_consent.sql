-- WhatsApp updates consent on orders (idempotent).

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS whatsapp_updates_consent BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS whatsapp_consent_at TIMESTAMP NULL;
