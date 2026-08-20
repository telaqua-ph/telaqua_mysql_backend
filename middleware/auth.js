/**
 * middleware/auth.js
 *
 * JWT verification middleware for protected admin routes.
 * Expects: Authorization: Bearer <token>
 */

import { verifyToken } from "../lib/auth.js";

/**
 * Express middleware — require a valid Bearer JWT.
 * On success: attaches payload to req.user and calls next().
 * On failure: sends HTTP 401 JSON.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || req.headers.Authorization;

  if (!header || typeof header !== "string" || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  const token = header.slice("Bearer ".length).trim();

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  try {
    const payload = verifyToken(token);
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }
}
