/**
 * Admin Web Push subscription + test endpoints.
 * Does not create orders. Errors never touch order placement.
 */

import {
  deleteSubscriptionForAdmin,
  getSubscriptionRowForAdmin,
  getSubscriptionStatusForAdmin,
  logSubscriptionEvent,
  toWebPushSubscription,
  upsertAdminPushSubscription,
  validatePushSubscriptionInput,
  isPushTablesMissingError,
} from "../services/adminPushSubscriptionService.js";
import { buildOrderPushPayload } from "../services/orderPushPayload.js";
import {
  getVapidPublicKey,
  isWebPushConfigured,
  sendWebPush,
  safeEndpointHint,
} from "../services/webPushConfig.js";

const TEST_COOLDOWN_MS = 30_000;
/** @type {Map<number, number>} */
const lastTestByAdmin = new Map();

function tablesMissingResponse(res) {
  return res.status(503).json({
    success: false,
    message:
      "Web Push tables are not installed. Run the admin Web Push migration on the database first.",
  });
}

export function getPublicVapidKey(req, res) {
  if (!isWebPushConfigured()) {
    return res.status(503).json({
      success: false,
      message: "Web Push is not configured on the server",
    });
  }
  return res.status(200).json({
    success: true,
    publicKey: getVapidPublicKey(),
  });
}

export async function getPushStatus(req, res) {
  try {
    const endpoint = String(req.query.endpoint || "").trim();
    if (!endpoint) {
      return res.status(400).json({
        success: false,
        message: "endpoint query parameter is required",
      });
    }
    const status = await getSubscriptionStatusForAdmin(req.admin.id, endpoint);
    return res.status(200).json({
      success: true,
      enabled: status.enabled,
      subscriptionId: status.subscriptionId || null,
      lastSeenAt: status.lastSeenAt || null,
    });
  } catch (error) {
    if (isPushTablesMissingError(error)) return tablesMissingResponse(res);
    console.error("getPushStatus failed:", { message: error?.message });
    return res.status(500).json({
      success: false,
      message: "Unable to check notification status",
    });
  }
}

export async function subscribePush(req, res) {
  try {
    if (!isWebPushConfigured()) {
      return res.status(503).json({
        success: false,
        message: "Web Push is not configured on the server",
      });
    }

    const validated = validatePushSubscriptionInput(req.body);
    if (validated.error) {
      return res.status(400).json({
        success: false,
        message: validated.error,
      });
    }

    const result = await upsertAdminPushSubscription(req.admin.id, validated.value);
    logSubscriptionEvent("subscribe", {
      adminId: req.admin.id,
      endpoint: validated.value.endpoint,
      subscriptionId: result.id,
    });

    return res.status(200).json({
      success: true,
      enabled: true,
      subscriptionId: result.id,
      created: result.created,
      message: result.created
        ? "Order notifications enabled on this device"
        : "Order notifications already registered for this device",
    });
  } catch (error) {
    if (isPushTablesMissingError(error)) return tablesMissingResponse(res);
    console.error("subscribePush failed:", {
      adminId: req.admin?.id,
      message: error?.message,
    });
    return res.status(500).json({
      success: false,
      message: "Unable to save push subscription",
    });
  }
}

export async function unsubscribePush(req, res) {
  try {
    const endpoint = String(req.body?.endpoint || req.query?.endpoint || "").trim();
    if (!endpoint) {
      return res.status(400).json({
        success: false,
        message: "endpoint is required",
      });
    }

    const result = await deleteSubscriptionForAdmin(req.admin.id, endpoint);
    logSubscriptionEvent("unsubscribe", {
      adminId: req.admin.id,
      endpoint,
    });

    return res.status(200).json({
      success: true,
      deleted: result.deleted,
      message: result.deleted
        ? "Order notifications disabled on this device"
        : "No subscription found for this device",
    });
  } catch (error) {
    if (isPushTablesMissingError(error)) return tablesMissingResponse(res);
    console.error("unsubscribePush failed:", {
      adminId: req.admin?.id,
      message: error?.message,
    });
    return res.status(500).json({
      success: false,
      message: "Unable to remove push subscription",
    });
  }
}

export async function sendTestPush(req, res) {
  try {
    if (!isWebPushConfigured()) {
      return res.status(503).json({
        success: false,
        message: "Web Push is not configured on the server",
      });
    }

    const adminId = req.admin.id;
    const now = Date.now();
    const last = lastTestByAdmin.get(adminId) || 0;
    if (now - last < TEST_COOLDOWN_MS) {
      const retryAfter = Math.ceil((TEST_COOLDOWN_MS - (now - last)) / 1000);
      return res.status(429).json({
        success: false,
        message: `Please wait ${retryAfter}s before sending another test notification`,
        retryAfterSeconds: retryAfter,
      });
    }

    const validated = validatePushSubscriptionInput(req.body?.subscription || req.body);
    if (validated.error) {
      return res.status(400).json({
        success: false,
        message: validated.error,
      });
    }

    const row = await getSubscriptionRowForAdmin(adminId, validated.value.endpoint);
    if (!row) {
      return res.status(400).json({
        success: false,
        message: "Enable order notifications on this device before sending a test",
      });
    }

    const payload = {
      ...buildOrderPushPayload({
        id: 0,
        order_number: "TEST",
        amount: 0,
        payment_mode: "razorpay",
        payment_status: "Pending",
      }),
      title: "New order received",
      body: "Test notification · this device only · no order created",
      tag: "telaqua-order-test",
      url: "/orders",
      test: true,
    };

    try {
      await sendWebPush(toWebPushSubscription(row), payload);
    } catch (error) {
      const statusCode = Number(error?.statusCode || error?.status || 0);
      console.error("Test push failed:", {
        adminId,
        endpoint: safeEndpointHint(row.endpoint),
        statusCode: statusCode || null,
        message: String(error?.message || "failed").slice(0, 200),
      });
      return res.status(502).json({
        success: false,
        message: "Push service rejected the test notification",
      });
    }

    lastTestByAdmin.set(adminId, now);
    logSubscriptionEvent("test", {
      adminId,
      endpoint: row.endpoint,
      subscriptionId: row.id,
    });

    return res.status(200).json({
      success: true,
      message: "Test notification sent to this device only",
    });
  } catch (error) {
    if (isPushTablesMissingError(error)) return tablesMissingResponse(res);
    console.error("sendTestPush failed:", {
      adminId: req.admin?.id,
      message: error?.message,
    });
    return res.status(500).json({
      success: false,
      message: "Unable to send test notification",
    });
  }
}

/** Test helper */
export function __resetTestPushRateLimit() {
  lastTestByAdmin.clear();
}
