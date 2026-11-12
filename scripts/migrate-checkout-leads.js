import "dotenv/config";
import { readFile } from "node:fs/promises";
import { pool } from "../config/db.js";
const sql = await readFile(new URL("../sql/create_checkout_leads.sql", import.meta.url), "utf8");
try { await pool.query(sql); console.log("Checkout leads migration complete."); }
finally { await pool.end(); }
