/**
 * middleware/requireActiveAdmin.js
 *
 * After requireAuth: ensure JWT maps to an active row in admins.
 * Store/account authorization = membership in admins with is_active.
 */

import { query } from "../config/db.js";

export async function requireActiveAdmin(req, res, next) {
  const adminId = Number(req.user?.admin_id ?? req.user?.id);
  if (!Number.isInteger(adminId) || adminId < 1) {
    return res.status(403).json({
      success: false,
      message: "Forbidden",
    });
  }

  try {
    const { rows } = await query(
      `SELECT id, email, is_active
       FROM admins
       WHERE id = ?
       LIMIT 1`,
      [adminId]
    );

    const admin = rows[0];
    const active =
      admin &&
      (admin.is_active === true ||
        admin.is_active === 1 ||
        String(admin.is_active) === "1");

    if (!admin || !active) {
      return res.status(403).json({
        success: false,
        message: "Forbidden",
      });
    }

    req.admin = {
      id: admin.id,
      email: admin.email,
      is_active: true,
    };
    return next();
  } catch (error) {
    console.error("requireActiveAdmin failed:", { message: error?.message });
    return res.status(503).json({
      success: false,
      message: "Unable to verify admin",
    });
  }
}
