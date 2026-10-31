-- One row per shipment: the WhatsApp "order shipped" message with the Shipway tracking link.
-- Created automatically on first send; this file is for manual setup / reference.
CREATE TABLE IF NOT EXISTS shipment_tracking_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shipment_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NULL,
  awb VARCHAR(64) NULL,
  channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
  status VARCHAR(20) NOT NULL DEFAULT 'sending',
  attempts INT UNSIGNED NOT NULL DEFAULT 1,
  last_error VARCHAR(500) NULL,
  sent_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tracking_notification (shipment_id, channel),
  KEY idx_tracking_notification_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
