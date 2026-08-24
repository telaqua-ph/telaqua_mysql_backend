import crypto from "node:crypto";

import {
  parseDelhiveryScanPush,
  persistDelhiveryScanPush,
} from "../services/delhiveryWebhookService.js";

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizedIp(value) {
  return String(value || "").trim().replace(/^::ffff:/, "");
}

function validateWebhookRequest(req) {
  const headerName = String(process.env.DELHIVERY_WEBHOOK_AUTH_HEADER || "").trim();
  const expectedValue = String(process.env.DELHIVERY_WEBHOOK_AUTH_VALUE || "").trim();
  if (!headerName || !expectedValue) {
    return { status: 503, message: "Delhivery webhook authentication is not configured." };
  }

  const providedValue = req.get(headerName);
  if (!providedValue || !safeEqual(providedValue, expectedValue)) {
    return { status: 401, message: "Unauthorized." };
  }

  const allowedIps = String(process.env.DELHIVERY_WEBHOOK_ALLOWED_IPS || "")
    .split(",")
    .map(normalizedIp)
    .filter(Boolean);
  if (allowedIps.length && !allowedIps.includes(normalizedIp(req.ip))) {
    return { status: 403, message: "Forbidden." };
  }
  return null;
}

export function createDelhiveryWebhookHandler(databasePool) {
  return async function handleDelhiveryWebhook(req, res) {
    const authError = validateWebhookRequest(req);
    if (authError) {
      return res.status(authError.status).json({ success: false, message: authError.message });
    }

    let payload;
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new Error("Empty body");
      }
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ success: false, message: "Invalid JSON payload." });
    }

    try {
      const event = parseDelhiveryScanPush(payload);
      const result = await persistDelhiveryScanPush(event, databasePool);
      return res.status(200).json({
        success: true,
        duplicate: result.duplicate,
        applied: result.applied,
      });
    } catch (error) {
      if (error?.code === "DELHIVERY_WEBHOOK_INVALID_PAYLOAD") {
        return res.status(400).json({ success: false, message: error.message });
      }
      if (error?.code === "DELHIVERY_WEBHOOK_SHIPMENT_NOT_FOUND") {
        return res.status(404).json({ success: false, message: error.message });
      }
      console.error("Delhivery webhook processing failed", {
        code: error?.code,
        message: error?.message,
      });
      return res.status(500).json({ success: false, message: "Webhook processing failed." });
    }
  };
}
