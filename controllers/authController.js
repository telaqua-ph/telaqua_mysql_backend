/**
 * controllers/authController.js
 *
 * Auth business logic — preserved from Vercel serverless handlers.
 */

import bcrypt from "bcryptjs";
import { query } from "../config/db.js";
import { signToken } from "../lib/auth.js";

const BCRYPT_SALT_ROUNDS = 12;

function trimStr(value) {
  return typeof value === "string" ? value.trim() : value;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** POST /api/auth/login */
export async function login(req, res) {
  try {
    const body = req.body;
    if (body == null || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        message: "Invalid JSON body",
      });
    }

    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password =
      typeof body.password === "string" ? body.password : "";

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "email and password are required",
      });
    }

    const { rows } = await query(
      `SELECT id, full_name, username, email, password_hash
       FROM admins
       WHERE email = ?
         AND is_active = true
       LIMIT 1`,
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const admin = rows[0];
    const isMatch = await bcrypt.compare(password, admin.password_hash);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    await query(
      `UPDATE admins
       SET last_login = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [admin.id]
    );

    const token = signToken({
      admin_id: admin.id,
      email: admin.email,
    });

    return res.status(200).json({
      success: true,
      token,
      admin: {
        id: admin.id,
        full_name: admin.full_name,
        username: admin.username,
        email: admin.email,
      },
    });
  } catch (error) {
    console.error("Login API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** GET /api/auth/profile */
export async function getProfile(req, res) {
  try {
    const adminId = req.user?.admin_id;
    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const { rows } = await query(
      `SELECT id, full_name, username, email, is_active, last_login, created_at, updated_at
       FROM admins
       WHERE id = ?
         AND is_active = true
       LIMIT 1`,
      [adminId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Admin not found",
      });
    }

    return res.status(200).json({
      success: true,
      admin: rows[0],
    });
  } catch (error) {
    console.error("Profile API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** PUT /api/auth/profile */
export async function updateProfile(req, res) {
  try {
    const adminId = req.user?.admin_id;
    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const body = req.body;
    if (body == null || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        message: "Invalid JSON body",
      });
    }

    const full_name =
      body.full_name !== undefined ? trimStr(body.full_name) : undefined;
    const emailRaw =
      body.email !== undefined ? trimStr(body.email) : undefined;

    if (full_name === undefined && emailRaw === undefined) {
      return res.status(400).json({
        success: false,
        message: "Provide full_name and/or email to update",
      });
    }

    if (full_name !== undefined && !full_name) {
      return res.status(400).json({
        success: false,
        message: "full_name cannot be empty",
      });
    }

    let email = undefined;
    if (emailRaw !== undefined) {
      const normalized = String(emailRaw).toLowerCase();
      if (!normalized || !isValidEmail(normalized)) {
        return res.status(400).json({
          success: false,
          message: "email must be a valid email address",
        });
      }
      email = normalized;
    }

    const { rows: existing } = await query(
      `SELECT id FROM admins
       WHERE id = ?
         AND is_active = true
       LIMIT 1`,
      [adminId]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Admin not found",
      });
    }

    if (email !== undefined) {
      const { rows: taken } = await query(
        `SELECT id FROM admins
         WHERE email = ?
           AND id <> ?
         LIMIT 1`,
        [email, adminId]
      );
      if (taken.length > 0) {
        return res.status(409).json({
          success: false,
          message: "Email is already in use",
        });
      }
    }

    await query(
      `UPDATE admins
       SET
         full_name = COALESCE(?, full_name),
         email = COALESCE(?, email),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [full_name ?? null, email ?? null, adminId]
    );

    const { rows } = await query(
      `SELECT id, full_name, username, email, is_active, last_login, created_at, updated_at
       FROM admins WHERE id = ? LIMIT 1`,
      [adminId]
    );

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      admin: rows[0],
    });
  } catch (error) {
    console.error("Profile API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** PUT /api/auth/change-password */
export async function changePassword(req, res) {
  try {
    const adminId = req.user?.admin_id;
    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const body = req.body;
    if (body == null || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        message: "Invalid JSON body",
      });
    }

    const current_password =
      typeof body.current_password === "string" ? body.current_password : "";
    const new_password =
      typeof body.new_password === "string" ? body.new_password : "";
    const confirm_password =
      typeof body.confirm_password === "string" ? body.confirm_password : "";

    if (!current_password || !new_password || !confirm_password) {
      return res.status(400).json({
        success: false,
        message:
          "current_password, new_password, and confirm_password are required",
      });
    }

    if (new_password !== confirm_password) {
      return res.status(400).json({
        success: false,
        message: "new_password and confirm_password do not match",
      });
    }

    if (new_password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "new_password must be at least 8 characters",
      });
    }

    const { rows } = await query(
      `SELECT id, password_hash
       FROM admins
       WHERE id = ?
         AND is_active = true
       LIMIT 1`,
      [adminId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Admin not found",
      });
    }

    const admin = rows[0];
    const isMatch = await bcrypt.compare(current_password, admin.password_hash);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    const password_hash = await bcrypt.hash(new_password, BCRYPT_SALT_ROUNDS);

    await query(
      `UPDATE admins
       SET
         password_hash = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [password_hash, adminId]
    );

    return res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Change password API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}
