/**
 * Server-side Meta Purchase events for website COD and verified Razorpay orders.
 * SHA-256 here is hashing, not encryption. The raw phone number is never logged.
 */

import { createHash } from "node:crypto";
import { query } from "../config/db.js";

const PIXEL_ID = "4612743812386133";
const inflight = new Map();
const memoryLedger = new Map();
let tableReady = false;
let missingTokenLogged = false;

export function normalizeIndianMobile(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  if (!/^91[6-9]\d{9}$/.test(digits)) return null;
  return digits;
}

/** Hash once. A value that is already a 64-character hex digest is left as-is. */
export function hashMetaPhone(normalizedDigits) {
  const value = String(normalizedDigits || "").trim().toLowerCase();
  if (!value) return null;
  if (/^[a-f0-9]{64}$/.test(value)) return value;
  return createHash("sha256").update(value).digest("hex");
}

export function purchaseUnixSeconds(order, nowMs = Date.now()) {
  const raw = order?.payment_date || order?.paymentDate || order?.created_at || order?.createdAt;
  const parsed = raw ? new Date(raw).getTime() : NaN;
  const ms = Number.isFinite(parsed) ? parsed : nowMs;
  return Math.floor(ms / 1000);
}

function orderAmount(order) {
  const amount = Number(order?.final_total ?? order?.finalTotal ?? order?.total_amount ?? order?.total);
  return Number.isFinite(amount) ? amount : null;
}

function isCodPurchase(order) {
  const mode = String(order?.payment_mode || order?.paymentMode || "").trim().toLowerCase();
  const method = String(order?.payment_method || order?.paymentMethod || "").trim().toLowerCase();
  return mode === "cod" || method === "cod" || method.includes("cash on delivery") || method.includes("cash_on_delivery");
}

function isPaid(order) {
  return String(order?.payment_status || order?.paymentStatus || "").trim().toLowerCase() === "paid";
}

export function buildMetaPurchaseBody(order, { eventId, eventTime, context = {} } = {}) {
  const amount = orderAmount(order);
  if (!eventId || !Number.isInteger(eventTime) || amount == null) return null;

  const userData = {};
  const phone = hashMetaPhone(normalizeIndianMobile(order?.phone));
  if (phone) userData.ph = [phone];

  const fbp = String(order?.fbp || "").trim();
  const fbc = String(order?.fbc || "").trim();
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const ip = String(context.clientIpAddress || "").trim();
  const userAgent = String(context.clientUserAgent || "").trim();
  if (ip) userData.client_ip_address = ip;
  if (userAgent) userData.client_user_agent = userAgent;

  return {
    data: [
      {
        event_name: "Purchase",
        event_time: eventTime,
        event_id: eventId,
        action_source: "website",
        user_data: userData,
        custom_data: {
          currency: "INR",
          value: amount,
        },
      },
    ],
  };
}

async function ensureLedgerTable() {
  if (tableReady) return;
  await query(
    `CREATE TABLE IF NOT EXISTS meta_purchase_events (
      event_id VARCHAR(32) NOT NULL,
      event_time INT UNSIGNED NOT NULL,
      sent_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id)
    )`
  );
  tableReady = true;
}

const defaultLedger = {
  async get(eventId) {
    const cached = memoryLedger.get(eventId);
    if (cached?.sent) return cached;
    try {
      await ensureLedgerTable();
      const { rows } = await query(
        `SELECT event_time, sent_at
         FROM meta_purchase_events
         WHERE event_id = ?
         LIMIT 1`,
        [eventId]
      );
      if (!rows[0]) return cached || null;
      const row = {
        eventTime: Number(rows[0].event_time),
        sent: rows[0].sent_at != null,
      };
      memoryLedger.set(eventId, row);
      return row;
    } catch (error) {
      console.error("Meta Purchase ledger read failed:", error?.message || "unknown error");
      return cached || null;
    }
  },
  async remember(eventId, eventTime) {
    const current = memoryLedger.get(eventId);
    if (!current) memoryLedger.set(eventId, { eventTime, sent: false });
    try {
      await ensureLedgerTable();
      await query(
        `INSERT INTO meta_purchase_events (event_id, event_time, sent_at)
         VALUES (?, ?, NULL)
         ON DUPLICATE KEY UPDATE event_id = event_id`,
        [eventId, eventTime]
      );
    } catch (error) {
      console.error("Meta Purchase ledger write failed:", error?.message || "unknown error");
    }
  },
  async markSent(eventId) {
    const current = memoryLedger.get(eventId) || { eventTime: 0, sent: false };
    memoryLedger.set(eventId, { ...current, sent: true });
    try {
      await ensureLedgerTable();
      await query(
        `UPDATE meta_purchase_events
         SET sent_at = CURRENT_TIMESTAMP
         WHERE event_id = ?`,
        [eventId]
      );
    } catch (error) {
      console.error("Meta Purchase ledger update failed:", error?.message || "unknown error");
    }
  },
};

async function loadOrderById(orderId) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const selects = [
    `SELECT id, order_number, phone, total_amount, final_total, payment_status,
            payment_mode, payment_method, created_at, payment_date,
            COALESCE(is_test_order, 0) AS is_test_order, fbp, fbc
     FROM orders WHERE id = ? LIMIT 1`,
    `SELECT id, order_number, phone, total_amount, final_total, payment_status,
            payment_mode, payment_method, created_at, payment_date,
            COALESCE(is_test_order, 0) AS is_test_order
     FROM orders WHERE id = ? LIMIT 1`,
    `SELECT id, order_number, phone, total_amount, payment_status,
            payment_mode, payment_method, created_at, payment_date
     FROM orders WHERE id = ? LIMIT 1`,
  ];
  let lastError;
  for (const sql of selects) {
    try {
      const { rows } = await query(sql, [id]);
      return rows[0] || null;
    } catch (error) {
      lastError = error;
    }
  }
  console.error("Meta Purchase order lookup failed:", lastError?.message || "unknown error");
  return null;
}

export async function deliverMetaPurchase(orderRef, deps = {}) {
  const order = deps.order || await (deps.loadOrder || loadOrderById)(orderRef?.id ?? orderRef);
  if (!order) return { status: "skipped", reason: "missing_order" };
  if (Number(order.is_test_order) === 1 || order.is_test_order === true) {
    return { status: "skipped", reason: "test_order" };
  }

  const eventId = String(order.order_number || order.orderNumber || "").trim();
  if (!/^TAQ-\d+$/.test(eventId)) return { status: "skipped", reason: "missing_event_id" };
  if (!isCodPurchase(order) && !isPaid(order)) {
    return { status: "skipped", reason: "not_a_completed_purchase" };
  }

  const amount = orderAmount(order);
  if (amount == null) return { status: "skipped", reason: "missing_amount" };

  const token = String(deps.accessToken ?? process.env.META_CAPI_ACCESS_TOKEN ?? "").trim();
  if (!token) {
    if (!missingTokenLogged && deps.accessToken === undefined) {
      missingTokenLogged = true;
      console.warn("Meta Purchase tracking is not configured. Set META_CAPI_ACCESS_TOKEN.");
    }
    return { status: "skipped", reason: "missing_token" };
  }

  const ledger = deps.ledger || defaultLedger;
  const existing = await ledger.get(eventId);
  if (existing?.sent) return { status: "duplicate", eventId };

  const eventTime = Number.isInteger(existing?.eventTime)
    ? existing.eventTime
    : purchaseUnixSeconds(order, deps.nowMs);
  await ledger.remember(eventId, eventTime);

  const body = buildMetaPurchaseBody(order, {
    eventId,
    eventTime,
    context: deps.context || {},
  });
  if (!body) return { status: "skipped", reason: "invalid_payload" };

  const testEventCode = String(deps.testEventCode ?? process.env.META_CAPI_TEST_EVENT_CODE ?? "").trim();
  if (testEventCode) body.test_event_code = testEventCode;

  const pixelId = String(deps.pixelId || process.env.META_PIXEL_ID || PIXEL_ID).trim() || PIXEL_ID;
  const version = String(deps.graphVersion || process.env.META_GRAPH_VERSION || "v21.0").trim() || "v21.0";
  const fetchImpl = deps.fetch || globalThis.fetch;
  const url = `https://graph.facebook.com/${version}/${pixelId}/events?access_token=${encodeURIComponent(token)}`;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response?.ok) {
      return { status: "failed", eventId, reason: `http_${response?.status || 0}` };
    }
  } catch {
    return { status: "failed", eventId, reason: "network" };
  }

  await ledger.markSent(eventId);
  return { status: "sent", eventId, eventTime };
}

export function scheduleMetaPurchase(orderRef, context = {}) {
  const orderId = Number(orderRef?.id);
  if (!Number.isInteger(orderId) || orderId <= 0) return;
  if (inflight.has(orderId)) return;

  const job = deliverMetaPurchase(
    { id: orderId },
    { context }
  ).then((result) => {
    if (result?.status === "failed") {
      console.error("Meta Purchase was not sent:", result.eventId || orderId, result.reason || "request failed");
    }
    return result;
  }).catch((error) => {
    console.error("Meta Purchase was not sent:", orderId, error?.message || "unexpected error");
  }).finally(() => {
    inflight.delete(orderId);
  });

  inflight.set(orderId, job);
}
