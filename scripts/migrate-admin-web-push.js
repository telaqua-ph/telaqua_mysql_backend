/**
 * Additive Web Push tables for admin new-order notifications.
 * Inspects information_schema first. Never alters orders.
 *
 * Usage: node scripts/migrate-admin-web-push.js
 * Do not run against production unless you intentionally apply the migration.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../config/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = path.join(__dirname, "..", "sql", "add_admin_web_push.sql");

const TABLES = [
  "admin_push_subscriptions",
  "order_push_notifications",
  "order_push_deliveries",
  "order_push_worker_state",
];

async function tableExists(client, name) {
  const { rows } = await client.query(
    `SELECT 1 AS ok
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
     LIMIT 1`,
    [name]
  );
  return rows.length > 0;
}

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"));
}

async function main() {
  const client = await pool.connect();
  try {
    console.log("Inspecting live MySQL for admin Web Push tables…");
    const existing = [];
    for (const name of TABLES) {
      if (await tableExists(client, name)) existing.push(name);
    }
    if (existing.length === TABLES.length) {
      console.log("All Web Push tables already exist. No change.");
      return;
    }
    if (existing.length > 0) {
      console.log("Partial install detected:", existing.join(", "));
    }

    const raw = fs.readFileSync(SQL_PATH, "utf8");
    const statements = splitSqlStatements(raw);
    for (const statement of statements) {
      await client.query(statement);
    }
    console.log("Admin Web Push tables prepared.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "admin Web Push migration failed:",
    error?.code || error?.message || error
  );
  process.exit(1);
});
