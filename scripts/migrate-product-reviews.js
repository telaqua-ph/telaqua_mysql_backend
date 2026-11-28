import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../config/db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = await fs.readFile(path.join(here, "../sql/add_product_reviews.sql"), "utf8");
for (const statement of sql.split(/;\s*(?:\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
  await pool.query(statement);
}
const { rows: columns } = await pool.query("SHOW COLUMNS FROM product_reviews");
const names = new Set(columns.map(column => column.Field));
for (const [name, type] of [['photo_data', 'MEDIUMBLOB'], ['photo_type', 'VARCHAR(20)'], ['photo2_data', 'MEDIUMBLOB'], ['photo2_type', 'VARCHAR(20)']]) {
  if (!names.has(name)) await pool.query(`ALTER TABLE product_reviews ADD COLUMN ${name} ${type} NULL`);
}
await pool.end();
console.log("Product reviews table is ready.");
