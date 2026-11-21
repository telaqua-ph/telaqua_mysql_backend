/**
 * Separate login for the Farmer Intel Map (second lock inside the admin).
 *
 * A staff member first signs in to the admin dashboard as usual. To open the
 * Farmer Intel Map they must also sign in with a Farmer Intel email + password
 * from the farmer_intel_users table. That returns a short-lived token which the
 * admin sends in the X-Farmer-Intel-Token header on every map request.
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { query } from "../config/db.js";

export const FARMER_INTEL_TOKEN_HEADER = "x-farmer-intel-token";
export const FARMER_INTEL_TOKEN_TYPE = "farmer_intel";
const TOKEN_MINUTES = Math.max(5, Number(process.env.FARMER_INTEL_SESSION_MINUTES) || 30);

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET environment variable is not configured");
  return value;
}

let tableReady = false;
export async function ensureFarmerIntelUsersTable() {
  if (tableReady) return;
  await query(`CREATE TABLE IF NOT EXISTS farmer_intel_users (
    id INT NOT NULL AUTO_INCREMENT,
    full_name VARCHAR(120) NULL,
    email VARCHAR(190) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    can_view_customer_data TINYINT(1) NOT NULL DEFAULT 0,
    can_manage_couriers TINYINT(1) NOT NULL DEFAULT 0,
    last_login DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_farmer_intel_users_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  tableReady = true;
}

export function signFarmerIntelToken({ userId, adminId }) {
  return jwt.sign(
    { type: FARMER_INTEL_TOKEN_TYPE, fi_user_id: userId, admin_id: adminId },
    secret(),
    { expiresIn: `${TOKEN_MINUTES}m` }
  );
}

export function verifyFarmerIntelToken(token) {
  const payload = jwt.verify(token, secret());
  if (payload?.type !== FARMER_INTEL_TOKEN_TYPE) throw new Error("Wrong token type");
  return payload;
}

const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase().slice(0, 190);

/** Returns { token, user, expiresInSeconds } or null when the credentials are wrong. */
export async function loginFarmerIntelUser({ email, password, adminId }) {
  await ensureFarmerIntelUsersTable();
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail || typeof password !== "string" || !password) return null;
  const { rows } = await query(
    `SELECT id, full_name, email, password_hash, is_active, can_view_customer_data, can_manage_couriers
     FROM farmer_intel_users WHERE LOWER(email) = ? LIMIT 1`,
    [cleanEmail]
  );
  const user = rows[0];
  // Always run bcrypt so a wrong email and a wrong password take the same time.
  const hash = user?.password_hash || "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
  const ok = await bcrypt.compare(password, hash).catch(() => false);
  if (!user || !ok || !Number(user.is_active)) return null;
  await query(`UPDATE farmer_intel_users SET last_login = NOW() WHERE id = ?`, [user.id]).catch(() => {});
  return {
    token: signFarmerIntelToken({ userId: user.id, adminId }),
    expiresInSeconds: TOKEN_MINUTES * 60,
    user: {
      name: user.full_name || user.email,
      email: user.email,
      canViewCustomerData: Boolean(Number(user.can_view_customer_data)),
      canManageCouriers: Boolean(Number(user.can_manage_couriers)),
    },
  };
}

/** Looks the user up on every request, so deactivating takes effect at once. */
export async function findActiveFarmerIntelUser(userId) {
  await ensureFarmerIntelUsersTable();
  const { rows } = await query(
    `SELECT id, email, is_active, can_view_customer_data, can_manage_couriers
     FROM farmer_intel_users WHERE id = ? LIMIT 1`,
    [Number(userId)]
  );
  const user = rows[0];
  return user && Number(user.is_active) ? user : null;
}
