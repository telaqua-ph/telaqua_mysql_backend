import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../config/db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = await fs.readFile(path.join(here, "../sql/add_farmer_intel_map.sql"), "utf8");
for (const statement of sql.split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
  try {
    await pool.query(statement);
  } catch (error) {
    // Indexes are intentionally additive; a rerun after a partially applied
    // migration must not fail merely because an index already exists.
    if (error?.code !== "ER_DUP_KEYNAME") throw error;
  }
}
console.log("Farmer Intel Map migration completed. Grant permissions explicitly before use.");
await pool.end();
