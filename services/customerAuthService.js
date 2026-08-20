import { query } from "../config/db.js";
import { verifyCustomerToken } from "../lib/customerAuth.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";

export function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

export async function authenticateCustomerRequest(req) {
  const token = getBearerToken(req);
  if (!token) {
    const error = new Error("Customer authentication required");
    error.statusCode = 401;
    throw error;
  }

  let payload;
  try {
    payload = verifyCustomerToken(token);
  } catch {
    const error = new Error("Invalid or expired customer session");
    error.statusCode = 401;
    throw error;
  }

  const normalized = normalizeIndianPhone(payload.phone);
  if (normalized.error || normalized.phoneNumber !== payload.sub) {
    const error = new Error("Invalid customer session");
    error.statusCode = 401;
    throw error;
  }

  const { rowCount } = await query(
    `UPDATE customer_sessions
     SET last_seen_at = CURRENT_TIMESTAMP
     WHERE token_id = ? AND phone = ? AND revoked_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP`,
    [payload.jti, normalized.phoneNumber]
  );
  if (!rowCount) {
    const error = new Error("Invalid or expired customer session");
    error.statusCode = 401;
    throw error;
  }

  const { rows } = await query(
    `SELECT token_id, phone, expires_at
     FROM customer_sessions
     WHERE token_id = ? AND phone = ?
     LIMIT 1`,
    [payload.jti, normalized.phoneNumber]
  );

  return {
    phone: normalized.phoneNumber,
    tokenId: String(rows[0].token_id),
    expiresAt: rows[0].expires_at,
  };
}

export function orderBelongsToCustomer(order, normalizedPhone) {
  const normalized = normalizeIndianPhone(order?.phone);
  return !normalized.error && normalized.phoneNumber === normalizedPhone;
}
