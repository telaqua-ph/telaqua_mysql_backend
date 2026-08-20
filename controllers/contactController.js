/**
 * controllers/contactController.js
 *
 * Contact form — logic preserved from api/contact/index.js.
 */

import { query } from "../config/db.js";

function trimStr(value) {
  return typeof value === "string" ? value.trim() : value;
}

function validateContactMessage(body) {
  if (!body || typeof body !== "object") {
    return { error: "All fields are required" };
  }

  const full_name = trimStr(body.full_name);
  const phone = trimStr(body.phone);
  const email = trimStr(body.email);
  const message = trimStr(body.message);

  if (!full_name || !phone || !email || !message) {
    return { error: "All fields are required" };
  }

  return {
    data: {
      full_name: String(full_name),
      phone: String(phone),
      email: String(email),
      message: String(message),
    },
  };
}

/** POST /api/contact */
export async function submitContact(req, res) {
  try {
    const body = req.body;
    if (body == null || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    const validation = validateContactMessage(body);
    if (validation.error) {
      return res.status(400).json({
        success: false,
        message: validation.error,
      });
    }

    const { full_name, phone, email, message } = validation.data;

    await query(
      `INSERT INTO contact_messages (
        full_name,
        phone,
        email,
        message
      ) VALUES (
        ?, ?, ?, ?
      )`,
      [full_name, phone, email, message]
    );

    return res.status(201).json({
      success: true,
      message: "Message submitted successfully",
    });
  } catch (error) {
    console.error("Contact API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}
