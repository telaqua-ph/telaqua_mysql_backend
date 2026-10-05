import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "../config/db.js";

const sql = readFileSync(fileURLToPath(new URL("../sql/add_shipway_logistics.sql", import.meta.url)), "utf8");
const statements = sql
  .split(/;\s*(?:\r?\n|$)/)
  .map((item) => item.replace(/^\s*--.*$/gm, "").trim())
  .filter(Boolean);
try {
  for (const statement of statements) await pool.query(statement);
  console.log(`Shipway logistics migration complete (${statements.length} statements).`);
} finally {
  await pool.end();
}
