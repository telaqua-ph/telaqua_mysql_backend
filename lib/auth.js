/**
 * lib/auth.js
 *
 * JWT helpers for admin authentication.
 * Signs and verifies tokens using process.env.JWT_SECRET only.
 * Never hardcode secrets or credentials.
 */

import jwt from "jsonwebtoken";

const TOKEN_EXPIRES_IN = "24h";

/** Resolve JWT secret from the environment. */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is not configured");
  }
  return secret;
}

/**
 * Sign a JWT for an authenticated admin.
 * @param {{ admin_id: number, email: string }} payload
 * @returns {string}
 */
export function signToken(payload) {
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: TOKEN_EXPIRES_IN,
  });
}

/**
 * Verify a JWT and return its payload.
 * Throws if the token is missing, invalid, or expired.
 * @param {string} token
 * @returns {{ admin_id: number, email: string }}
 */
export function verifyToken(token) {
  return jwt.verify(token, getJwtSecret());
}
