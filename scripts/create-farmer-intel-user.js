/**
 * Create or update a Farmer Intel Map login (separate from the admin login).
 *
 *   npm run farmer-intel:user -- <email> <password> "<Full Name>" [--customer-data] [--couriers]
 *   npm run farmer-intel:user -- <email> --disable
 *
 * Uses the DB_* values from .env. Passwords are stored as bcrypt hashes only.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool, query } from "../config/db.js";
import { ensureFarmerIntelUsersTable } from "../services/farmerIntelAuth.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [email, password, fullName] = args.filter((a) => !a.startsWith("--"));

async function main() {
  if (!email) throw new Error("Usage: npm run farmer-intel:user -- <email> <password> \"<Full Name>\" [--customer-data] [--couriers]");
  await ensureFarmerIntelUsersTable();
  const cleanEmail = email.trim().toLowerCase();
  if (flags.has("--disable")) {
    await query(`UPDATE farmer_intel_users SET is_active = 0 WHERE LOWER(email) = ?`, [cleanEmail]);
    console.log(`Disabled Farmer Intel login: ${cleanEmail}`);
    return;
  }
  if (!password || password.length < 8) throw new Error("Password must be at least 8 characters.");
  const hash = await bcrypt.hash(password, 10);
  await query(
    `INSERT INTO farmer_intel_users (full_name, email, password_hash, is_active, can_view_customer_data, can_manage_couriers)
     VALUES (?, ?, ?, 1, ?, ?)
     ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), password_hash = VALUES(password_hash), is_active = 1,
       can_view_customer_data = VALUES(can_view_customer_data), can_manage_couriers = VALUES(can_manage_couriers)`,
    [fullName || null, cleanEmail, hash, flags.has("--customer-data") ? 1 : 0, flags.has("--couriers") ? 1 : 0]
  );
  console.log(`Farmer Intel login ready: ${cleanEmail} (customer data: ${flags.has("--customer-data") ? "yes" : "no"}, couriers: ${flags.has("--couriers") ? "yes" : "no"})`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
