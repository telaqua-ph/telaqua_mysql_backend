/**
 * Read-only Hostinger MySQL connectivity checks (safe — no writes).
 * Usage: node scripts/mysql-readonly-check.js
 */

import "dotenv/config";
import { pool, isDatabaseConfigured } from "../config/db.js";

async function safeCount(table) {
  const result = await pool.query(`SELECT COUNT(*) AS cnt FROM \`${table}\``);
  return Number(result.rows[0]?.cnt ?? result.rows[0]?.CNT ?? 0);
}

async function main() {
  if (!isDatabaseConfigured()) {
    console.error("FAIL: DB_HOST, DB_NAME, and DB_USER must be set in .env");
    process.exitCode = 1;
    return;
  }

  try {
    await pool.query("SELECT 1 AS ok");
    console.log("PASS: SELECT 1");

    const tables = [
      "orders",
      "admins",
      "inventory",
      "inventory_history",
      "promo_codes",
      "admin_notifications",
      "customer_sessions",
      "customer_auth_otps",
      "razorpay_webhook_events",
    ];

    for (const table of tables) {
      const count = await safeCount(table);
      console.log(`PASS: COUNT(${table}) = ${count}`);
    }

    const promo = await pool.query(
      `SELECT code, used_count, usage_limit
       FROM promo_codes
       WHERE code = ?
       LIMIT 1`,
      ["FREEDOM50"]
    );
    if (promo.rows.length === 0) {
      console.warn("WARN: FREEDOM50 promo row not found");
    } else {
      const row = promo.rows[0];
      console.log("PASS: FREEDOM50", {
        code: row.code,
        used_count: row.used_count,
        usage_limit: row.usage_limit,
      });
    }
  } catch (err) {
    console.error("FAIL:", err?.code || err?.message || err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
