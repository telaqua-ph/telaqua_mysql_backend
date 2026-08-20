/**
 * controllers/swipeWebhookController.js
 *
 * Optional Swipe document webhook handler.
 */

import crypto from "node:crypto";
import { query } from "../config/db.js";

function verifySignature(rawBody, signature, secret) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature || ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** POST /api/webhooks/swipe */
export async function handleSwipeWebhook(req, res) {
  const secret = (process.env.SWIPE_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return res.status(503).json({
      success: false,
      message: "SWIPE_WEBHOOK_SECRET is not configured",
    });
  }

  try {
    const signature =
      req.headers["x-signature"] || req.headers["X-Signature"];
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body || "");

    if (!signature || !verifySignature(rawBody, signature, secret)) {
      return res.status(401).json({
        success: false,
        message: "Invalid signature",
      });
    }

    const payload = JSON.parse(rawBody.toString("utf8"));
    if (payload?.event_type !== "document") {
      return res.status(200).json({ success: true, ignored: true });
    }

    const hashId = payload?.data?.hash_id
      ? String(payload.data.hash_id)
      : null;
    const serialNumber = payload?.data?.serial_number
      ? String(payload.data.serial_number)
      : null;
    const documentType = String(payload?.data?.document_type || "");

    if (!hashId || documentType !== "invoice") {
      return res.status(200).json({ success: true, ignored: true });
    }

    await query(
      `UPDATE orders
       SET
         swipe_invoice_id = COALESCE(swipe_invoice_id, ?),
         invoice_number = COALESCE(invoice_number, ?),
         invoice_generated_at = COALESCE(invoice_generated_at, CURRENT_TIMESTAMP),
         invoice_status = CASE
           WHEN invoice_status = 'generated' THEN invoice_status
           ELSE 'generated'
         END,
         updated_at = CURRENT_TIMESTAMP
       WHERE swipe_invoice_id = ?
          OR invoice_number = ?`,
      [hashId, serialNumber]
    );

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Swipe webhook error:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}
