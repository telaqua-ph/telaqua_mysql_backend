/**
 * Additive migration for the ₹99 COD advance delivery fee.
 *
 * Creates cod_advance_payments and adds nullable cod_advance_* columns to `orders`.
 * Never drops or rewrites existing data. Safe to run more than once.
 *
 * Usage: node scripts/migrate-cod-advance-fee.js
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { pool } from "../config/db.js";

const SQL_FILE = new URL("../sql/add_cod_advance_fee.sql", import.meta.url);

function statements(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function main() {
  const client = await pool.connect();
  try {
    for (const statement of statements(await readFile(SQL_FILE, "utf8"))) {
      const label = statement.replace(/\s+/g, " ").slice(0, 90);
      try {
        await client.query(statement);
        console.log("OK  ", label);
      } catch (error) {
        if (error?.code !== "ER_DUP_FIELDNAME") throw error;
        console.log("SKIP", label, "(column already exists)");
      }
    }
    console.log("COD advance fee migration complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("COD advance fee migration failed:", error?.message || error);
  process.exitCode = 1;
});
