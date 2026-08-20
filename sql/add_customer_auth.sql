-- Customer WhatsApp OTP authentication and revocable JWT sessions.
-- Safe to run multiple times. Historical orders are not modified.

CREATE TABLE IF NOT EXISTS customer_auth_otps (
  id BIGSERIAL PRIMARY KEY,
  phone VARCHAR(10) NOT NULL,
  otp_hash VARCHAR(160) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
  verified_at TIMESTAMP NULL,
  invalidated_at TIMESTAMP NULL,
  request_ip_hash CHAR(64) NOT NULL,
  provider_message_id TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customer_auth_otps_phone_created
  ON customer_auth_otps (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_auth_otps_ip_created
  ON customer_auth_otps (request_ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS customer_sessions (
  token_id UUID PRIMARY KEY,
  phone VARCHAR(10) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customer_sessions_phone
  ON customer_sessions (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_active
  ON customer_sessions (expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_normalized_phone
  ON orders ((RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10)));
