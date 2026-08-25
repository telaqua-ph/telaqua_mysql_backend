-- Additive checkout reminder tracking for Interakt WhatsApp.
-- One reminder per order. Does not alter orders / Razorpay columns.

CREATE TABLE IF NOT EXISTS checkout_reminders (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id INT NOT NULL,
  customer_phone VARCHAR(20) NOT NULL,
  reminder_reason VARCHAR(32) NOT NULL,
  reminder_sent TINYINT(1) NOT NULL DEFAULT 0,
  reminder_sent_at DATETIME NULL,
  send_status VARCHAR(32) NULL,
  interakt_message_id VARCHAR(128) NULL,
  interakt_error TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_checkout_reminders_order (order_id),
  KEY idx_checkout_reminders_reason (reminder_reason, reminder_sent)
);
