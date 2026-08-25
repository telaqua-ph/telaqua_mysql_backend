/**
 * Additive payment_mode migration for live Hostinger MySQL `orders`.
 *
 * Inspects information_schema first. Never drops/recreates the table.
 * Does not rewrite Razorpay IDs, amounts, or order numbers.
 *
 * Usage: node scripts/migrate-payment-mode.js
 */

import "dotenv/config";
import { pool } from "../config/db.js";

const COD_METHODS_SQL = `LOWER(TRIM(payment_method)) IN ('cod', 'cash on delivery', 'cash_on_delivery')`;

async function columnInfo(client) {
  const { rows } = await client.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'payment_mode'
     LIMIT 1`
  );
  return rows[0] || null;
}

async function main() {
  const client = await pool.connect();
  try {
    console.log("Inspecting live MySQL `orders` table…");
    const before = await columnInfo(client);
    if (before) {
      console.log("payment_mode already exists:", {
        type: before.COLUMN_TYPE || before.column_type,
        nullable: before.IS_NULLABLE || before.is_nullable,
        default: before.COLUMN_DEFAULT || before.column_default,
      });
    } else {
      console.log("payment_mode is missing. Adding ENUM('razorpay','cod') NOT NULL DEFAULT 'razorpay'.");
      try {
        await client.query(
          `ALTER TABLE orders
           ADD COLUMN payment_mode ENUM('razorpay', 'cod') NOT NULL DEFAULT 'razorpay'`
        );
      } catch (error) {
        if (error?.code !== "ER_DUP_FIELDNAME") throw error;
        console.log("Column already present (ER_DUP_FIELDNAME). Continuing.");
      }
    }

    const after = await columnInfo(client);
    if (!after) {
      throw new Error("payment_mode was not created. Aborting backfill.");
    }

    const backfill = await client.query(
      `UPDATE orders
       SET payment_mode = 'cod'
       WHERE ${COD_METHODS_SQL}
         AND payment_mode <> 'cod'`
    );

    const { rows: summary } = await client.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN payment_mode = 'razorpay' THEN 1 ELSE 0 END) AS razorpay_rows,
         SUM(CASE WHEN payment_mode = 'cod' THEN 1 ELSE 0 END) AS cod_rows
       FROM orders`
    );
    const row = summary[0] || {};
    console.log("Backfill complete.", {
      codRowsUpdated: backfill.rowCount ?? 0,
      total: Number(row.total || 0),
      razorpay: Number(row.razorpay_rows || 0),
      cod: Number(row.cod_rows || 0),
    });
    console.log("payment_mode migration complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("payment_mode migration failed:", error?.code || error?.message || error);
  process.exitCode = 1;
});
