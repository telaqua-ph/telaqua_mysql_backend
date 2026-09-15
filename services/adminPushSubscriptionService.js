/**
 * Admin Web Push subscription persistence (multi-device).
 * Deduplicates by endpoint; ownership follows the registering admin.
 */

import { query } from "../config/db.js";
import { isDuplicateKeyError, isMissingTableError } from "../lib/dbErrors.js";
import { safeEndpointHint } from "./webPushConfig.js";

const MAX_ENDPOINT = 512;
const MAX_KEY = 255;
const MAX_UA = 512;

export function validatePushSubscriptionInput(body) {
  const endpoint = String(body?.endpoint || "").trim();
  const p256dh = String(body?.keys?.p256dh || body?.p256dh || "").trim();
  const auth = String(body?.keys?.auth || body?.auth || "").trim();
  const userAgent = String(body?.userAgent || body?.user_agent || "").trim().slice(0, MAX_UA);

  if (!endpoint || endpoint.length > MAX_ENDPOINT) {
    return { error: "Valid subscription endpoint is required" };
  }
  if (!/^https:\/\//i.test(endpoint)) {
    return { error: "Subscription endpoint must be HTTPS" };
  }
  if (!p256dh || p256dh.length > MAX_KEY) {
    return { error: "Subscription p256dh key is required" };
  }
  if (!auth || auth.length > MAX_KEY) {
    return { error: "Subscription auth key is required" };
  }

  return {
    value: {
      endpoint,
      p256dh,
      auth,
      userAgent: userAgent || null,
    },
  };
}

export async function upsertAdminPushSubscription(adminId, subscription) {
  const id = Number(adminId);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error("Invalid admin id");
  }

  const existing = await query(
    `SELECT id, admin_id FROM admin_push_subscriptions WHERE endpoint = ? LIMIT 1`,
    [subscription.endpoint]
  );

  if (existing.rows[0]) {
    const row = existing.rows[0];
    await query(
      `UPDATE admin_push_subscriptions
       SET admin_id = ?,
           p256dh = ?,
           auth = ?,
           user_agent = COALESCE(?, user_agent),
           last_seen_at = CURRENT_TIMESTAMP
       WHERE endpoint = ?`,
      [
        id,
        subscription.p256dh,
        subscription.auth,
        subscription.userAgent,
        subscription.endpoint,
      ]
    );
    return {
      id: row.id,
      transferred: Number(row.admin_id) !== id,
      created: false,
    };
  }

  try {
    const inserted = await query(
      `INSERT INTO admin_push_subscriptions
         (admin_id, endpoint, p256dh, auth, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        subscription.endpoint,
        subscription.p256dh,
        subscription.auth,
        subscription.userAgent,
      ]
    );
    return {
      id: inserted.insertId,
      transferred: false,
      created: true,
    };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const again = await query(
        `SELECT id FROM admin_push_subscriptions WHERE endpoint = ? LIMIT 1`,
        [subscription.endpoint]
      );
      await query(
        `UPDATE admin_push_subscriptions
         SET admin_id = ?,
             p256dh = ?,
             auth = ?,
             user_agent = COALESCE(?, user_agent),
             last_seen_at = CURRENT_TIMESTAMP
         WHERE endpoint = ?`,
        [
          id,
          subscription.p256dh,
          subscription.auth,
          subscription.userAgent,
          subscription.endpoint,
        ]
      );
      return {
        id: again.rows[0]?.id,
        transferred: true,
        created: false,
      };
    }
    throw error;
  }
}

export async function getSubscriptionStatusForAdmin(adminId, endpoint) {
  const id = Number(adminId);
  const ep = String(endpoint || "").trim();
  if (!Number.isInteger(id) || id < 1 || !ep) {
    return { enabled: false };
  }

  const { rows } = await query(
    `SELECT id, admin_id, last_seen_at
     FROM admin_push_subscriptions
     WHERE endpoint = ?
     LIMIT 1`,
    [ep]
  );
  const row = rows[0];
  if (!row || Number(row.admin_id) !== id) {
    return { enabled: false };
  }
  return {
    enabled: true,
    subscriptionId: row.id,
    lastSeenAt: row.last_seen_at,
  };
}

export async function deleteSubscriptionForAdmin(adminId, endpoint) {
  const id = Number(adminId);
  const ep = String(endpoint || "").trim();
  if (!Number.isInteger(id) || id < 1 || !ep) {
    return { deleted: false };
  }

  const result = await query(
    `DELETE FROM admin_push_subscriptions
     WHERE admin_id = ? AND endpoint = ?`,
    [id, ep]
  );
  return { deleted: (result.rowCount || 0) > 0 };
}

export async function deleteSubscriptionById(subscriptionId) {
  const id = Number(subscriptionId);
  if (!Number.isInteger(id) || id < 1) return { deleted: false };
  const result = await query(
    `DELETE FROM admin_push_subscriptions WHERE id = ?`,
    [id]
  );
  console.log("Removed expired push subscription:", {
    subscriptionId: id,
  });
  return { deleted: (result.rowCount || 0) > 0 };
}

export async function getSubscriptionRowForAdmin(adminId, endpoint) {
  const id = Number(adminId);
  const ep = String(endpoint || "").trim();
  if (!Number.isInteger(id) || id < 1 || !ep) return null;

  const { rows } = await query(
    `SELECT id, admin_id, endpoint, p256dh, auth
     FROM admin_push_subscriptions
     WHERE admin_id = ? AND endpoint = ?
     LIMIT 1`,
    [id, ep]
  );
  return rows[0] || null;
}

export async function listActiveAdminSubscriptions() {
  const { rows } = await query(
    `SELECT s.id, s.admin_id, s.endpoint, s.p256dh, s.auth
     FROM admin_push_subscriptions s
     INNER JOIN admins a ON a.id = s.admin_id
     WHERE a.is_active = true OR a.is_active = 1`
  );
  return rows;
}

export function toWebPushSubscription(row) {
  return {
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth,
    },
  };
}

export function logSubscriptionEvent(event, { adminId, endpoint, subscriptionId } = {}) {
  console.log(`Admin push ${event}:`, {
    adminId: adminId ?? null,
    subscriptionId: subscriptionId ?? null,
    endpoint: safeEndpointHint(endpoint),
  });
}

export function isPushTablesMissingError(error) {
  return isMissingTableError(error);
}
