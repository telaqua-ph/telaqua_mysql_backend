/**
 * Additive checkout_reminders table for Interakt WhatsApp reminders.
 * Inspects information_schema first. Never drops/recreates orders.
 *
 * Usage: node scripts/migrate-checkout-reminders.js
 */

import "dotenv/config";
import { pool } from "../config/db.js";

async function tableExists(client) {
  const { rows } = await client.query(
    `SELECT 1 AS ok
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'checkout_reminders'
     LIMIT 1`
  );
  return rows.length > 0;
}

async function main() {
  const client = await pool.connect();
  try {
    console.log("Inspecting live MySQL for checkout_reminders…");
    if (await tableExists(client)) {
      console.log("checkout_reminders already exists. No change.");
      return;
    }

    console.log("Creating checkout_reminders…");
    await client.query(`
      CREATE TABLE checkout_reminders (
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
      )
    `);
    console.log("checkout_reminders created.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("checkout_reminders migration failed:", error?.code || error?.message || error);
  process.exit(1);
});
