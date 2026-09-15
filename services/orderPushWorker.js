/**
 * Background worker: detect committed new orders and deliver Web Push
 * to registered admin devices. Independent of order-placement transactions.
 *
 * Baseline / late commits / restarts
 * ----------------------------------
 * On first start, order_push_worker_state is seeded with
 *   baseline_order_id = MAX(orders.id)
 *   high_watermark_*  = same max id / created_at
 * so historical orders (id <= baseline) never notify.
 *
 * Each tick selects orders that are NOT already in order_push_notifications AND
 *   id > baseline_order_id AND
 *   (id > high_watermark_id OR created_at within lookback of watermark created_at).
 * UNIQUE(order_id) on notifications prevents duplicate jobs on overlapping scans.
 * Lookback catches rows whose INSERT committed after we advanced the watermark
 * (late-visible transactions) without relying only on MAX(id).
 * Watermark is durable in MySQL, so process restarts resume safely.
 *
 * Delivery
 * --------
 * One order_push_deliveries row per (notification, subscription).
 * Claim uses claim_token + conditional UPDATE so overlapping Node instances
 * cannot send the same job twice. Only failed/pending rows retry; sent rows
 * are left alone. 404/410 from the push service deletes the subscription.
 */

import { randomUUID } from "node:crypto";
import { query } from "../config/db.js";
import { isDuplicateKeyError, isMissingTableError } from "../lib/dbErrors.js";
import { columnExists } from "../lib/schemaHelpers.js";
import {
  deleteSubscriptionById,
  listActiveAdminSubscriptions,
  toWebPushSubscription,
} from "./adminPushSubscriptionService.js";
import {
  ORDER_PUSH_MAX_ATTEMPTS,
  buildOrderPushPayload,
  deliveryBackoffSeconds,
  isExpiredPushStatus,
  isOrderEligibleForScan,
  nextWatermark,
} from "./orderPushPayload.js";
import {
  isOrderPushEnabled,
  sendWebPush,
  safeEndpointHint,
} from "./webPushConfig.js";

const DEFAULT_INTERVAL_MS = 20_000;
const DEFAULT_LOOKBACK_SECONDS = 120;
const CLAIM_STALE_MINUTES = 5;
const SCAN_LIMIT = 50;
const DELIVERY_BATCH = 25;

let timer = null;
let running = false;
let tablesReady = false;

/** Optional injectables for isolated tests */
let pushSender = sendWebPush;
let clock = () => new Date();

export function __setOrderPushTestHooks(hooks = {}) {
  if (hooks.pushSender) pushSender = hooks.pushSender;
  if (hooks.clock) clock = hooks.clock;
  if (hooks.resetTablesReady) tablesReady = false;
}

export function __resetOrderPushTestHooks() {
  pushSender = sendWebPush;
  clock = () => new Date();
  tablesReady = false;
}

export function orderPushScanIntervalMs() {
  const n = Number(process.env.ORDER_PUSH_SCAN_INTERVAL_MS);
  if (!Number.isFinite(n) || n < 5_000) return DEFAULT_INTERVAL_MS;
  return Math.min(Math.floor(n), 5 * 60_000);
}

export function orderPushLookbackSeconds() {
  const n = Number(process.env.ORDER_PUSH_LOOKBACK_SECONDS);
  if (!Number.isFinite(n) || n < 30) return DEFAULT_LOOKBACK_SECONDS;
  return Math.min(Math.floor(n), 600);
}

async function pushTablesExist() {
  const ok = await columnExists("order_push_worker_state", "baseline_order_id").catch(
    () => false
  );
  return Boolean(ok);
}

export async function ensureOrderPushTablesReady() {
  if (tablesReady) return true;
  const exists = await pushTablesExist();
  tablesReady = exists;
  return exists;
}

async function loadOrCreateWorkerState() {
  const { rows } = await query(
    `SELECT id, baseline_order_id, high_watermark_id, high_watermark_created_at, lookback_seconds
     FROM order_push_worker_state
     WHERE id = 1
     LIMIT 1`
  );
  if (rows[0]) {
    return {
      baselineOrderId: Number(rows[0].baseline_order_id) || 0,
      highWatermarkId: Number(rows[0].high_watermark_id) || 0,
      highWatermarkCreatedAt: rows[0].high_watermark_created_at,
      lookbackSeconds: Number(rows[0].lookback_seconds) || orderPushLookbackSeconds(),
    };
  }

  const maxRes = await query(
    `SELECT COALESCE(MAX(id), 0) AS max_id,
            COALESCE(MAX(created_at), NOW()) AS max_created
     FROM orders`
  );
  const maxId = Number(maxRes.rows[0]?.max_id) || 0;
  const maxCreated = maxRes.rows[0]?.max_created || clock();
  const lookback = orderPushLookbackSeconds();

  try {
    await query(
      `INSERT INTO order_push_worker_state
         (id, baseline_order_id, high_watermark_id, high_watermark_created_at, lookback_seconds)
       VALUES (1, ?, ?, ?, ?)`,
      [maxId, maxId, maxCreated, lookback]
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }

  const again = await query(
    `SELECT baseline_order_id, high_watermark_id, high_watermark_created_at, lookback_seconds
     FROM order_push_worker_state WHERE id = 1 LIMIT 1`
  );
  const row = again.rows[0];
  console.log("Order push baseline established:", {
    baselineOrderId: Number(row?.baseline_order_id) || maxId,
    note: "Historical orders at or below baseline will not notify",
  });
  return {
    baselineOrderId: Number(row?.baseline_order_id) || maxId,
    highWatermarkId: Number(row?.high_watermark_id) || maxId,
    highWatermarkCreatedAt: row?.high_watermark_created_at || maxCreated,
    lookbackSeconds: Number(row?.lookback_seconds) || lookback,
  };
}

async function persistWatermark(state) {
  await query(
    `UPDATE order_push_worker_state
     SET high_watermark_id = ?,
         high_watermark_created_at = ?,
         lookback_seconds = ?
     WHERE id = 1`,
    [
      state.highWatermarkId,
      state.highWatermarkCreatedAt,
      state.lookbackSeconds || orderPushLookbackSeconds(),
    ]
  );
}

async function amountSelectSql() {
  const hasFinal = await columnExists("orders", "final_total").catch(() => false);
  if (hasFinal) {
    return "COALESCE(o.final_total, o.total_amount) AS amount";
  }
  return "o.total_amount AS amount";
}

async function scanCommittedOrders(state) {
  const amountExpr = await amountSelectSql();
  const hasMode = await columnExists("orders", "payment_mode").catch(() => false);
  const modeCol = hasMode ? "o.payment_mode" : "o.payment_method AS payment_mode";

  const { rows } = await query(
    `SELECT o.id,
            o.order_number,
            ${amountExpr},
            ${modeCol},
            o.payment_status,
            o.created_at
     FROM orders o
     LEFT JOIN order_push_notifications n ON n.order_id = o.id
     WHERE n.order_id IS NULL
       AND o.id > ?
       AND (
         o.id > ?
         OR o.created_at >= DATE_SUB(?, INTERVAL ? SECOND)
       )
     ORDER BY o.id ASC
     LIMIT ?`,
    [
      state.baselineOrderId,
      state.highWatermarkId,
      state.highWatermarkCreatedAt,
      state.lookbackSeconds || orderPushLookbackSeconds(),
      SCAN_LIMIT,
    ]
  );

  // Defense in depth — same rules as pure helper
  const notified = new Set();
  return rows.filter((row) => {
    const ok = isOrderEligibleForScan(row, state, notified);
    if (ok) notified.add(Number(row.id));
    return ok;
  });
}

/**
 * Also advance watermark over orders already notified in the lookback window
 * so created_at watermark keeps moving.
 */
async function loadScannedWindow(state) {
  const { rows } = await query(
    `SELECT o.id, o.created_at
     FROM orders o
     WHERE o.id > ?
       AND (
         o.id > ?
         OR o.created_at >= DATE_SUB(?, INTERVAL ? SECOND)
       )
     ORDER BY o.id ASC
     LIMIT ?`,
    [
      state.baselineOrderId,
      state.highWatermarkId,
      state.highWatermarkCreatedAt,
      state.lookbackSeconds || orderPushLookbackSeconds(),
      SCAN_LIMIT,
    ]
  );
  return rows;
}

export async function createNotificationAndDeliveries(order) {
  const payloadFields = {
    order_id: Number(order.id),
    order_number: String(order.order_number || order.id),
    amount: Number(order.amount) || 0,
    payment_mode: order.payment_mode != null ? String(order.payment_mode).slice(0, 32) : null,
    payment_status: String(order.payment_status || "Pending").slice(0, 32),
  };

  let notificationId;
  try {
    const inserted = await query(
      `INSERT INTO order_push_notifications
         (order_id, order_number, amount, payment_mode, payment_status)
       VALUES (?, ?, ?, ?, ?)`,
      [
        payloadFields.order_id,
        payloadFields.order_number,
        payloadFields.amount,
        payloadFields.payment_mode,
        payloadFields.payment_status,
      ]
    );
    notificationId = inserted.insertId;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { created: false, reason: "duplicate_notification" };
    }
    throw error;
  }

  const subs = await listActiveAdminSubscriptions();
  let deliveryCount = 0;
  for (const sub of subs) {
    try {
      await query(
        `INSERT INTO order_push_deliveries
           (notification_id, subscription_id, status, next_attempt_at)
         VALUES (?, ?, 'pending', NULL)`,
        [notificationId, sub.id]
      );
      deliveryCount += 1;
    } catch (error) {
      if (isDuplicateKeyError(error)) continue;
      throw error;
    }
  }

  return {
    created: true,
    notificationId,
    deliveryCount,
    orderId: payloadFields.order_id,
  };
}

async function claimDeliveryBatch() {
  const claimToken = randomUUID();
  const { rows } = await query(
    `SELECT id
     FROM order_push_deliveries
     WHERE attempts < ?
       AND (
         (
           status IN ('pending', 'failed')
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         )
         OR (
           status = 'claimed'
           AND claimed_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
         )
       )
     ORDER BY id ASC
     LIMIT ?`,
    [ORDER_PUSH_MAX_ATTEMPTS, CLAIM_STALE_MINUTES, DELIVERY_BATCH]
  );

  const claimedIds = [];
  for (const row of rows) {
    const result = await query(
      `UPDATE order_push_deliveries
       SET status = 'claimed',
           claim_token = ?,
           claimed_at = NOW(),
           attempts = attempts + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND attempts < ?
         AND (
           (
             status IN ('pending', 'failed')
             AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
           )
           OR (
             status = 'claimed'
             AND claimed_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
           )
         )`,
      [claimToken, row.id, ORDER_PUSH_MAX_ATTEMPTS, CLAIM_STALE_MINUTES]
    );
    if ((result.rowCount || 0) === 1) {
      claimedIds.push(row.id);
    }
  }

  if (claimedIds.length === 0) return [];

  const placeholders = claimedIds.map(() => "?").join(",");
  const { rows: jobs } = await query(
    `SELECT d.id AS delivery_id,
            d.notification_id,
            d.subscription_id,
            d.attempts,
            d.claim_token,
            n.order_id,
            n.order_number,
            n.amount,
            n.payment_mode,
            n.payment_status,
            s.endpoint,
            s.p256dh,
            s.auth,
            s.admin_id,
            a.is_active AS admin_is_active
     FROM order_push_deliveries d
     INNER JOIN order_push_notifications n ON n.id = d.notification_id
     INNER JOIN admin_push_subscriptions s ON s.id = d.subscription_id
     LEFT JOIN admins a ON a.id = s.admin_id
     WHERE d.id IN (${placeholders})
       AND d.claim_token = ?`,
    [...claimedIds, claimToken]
  );
  return jobs;
}

async function markDeliverySent(deliveryId, claimToken) {
  await query(
    `UPDATE order_push_deliveries
     SET status = 'sent',
         sent_at = NOW(),
         last_error = NULL,
         next_attempt_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND claim_token = ?`,
    [deliveryId, claimToken]
  );
}

async function markDeliveryFailed(deliveryId, claimToken, attempts, errorMessage) {
  const backoff = deliveryBackoffSeconds(attempts);
  if (backoff == null) {
    await query(
      `UPDATE order_push_deliveries
       SET status = 'failed',
           last_error = ?,
           next_attempt_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND claim_token = ?`,
      [String(errorMessage || "max attempts").slice(0, 500), deliveryId, claimToken]
    );
    return;
  }
  await query(
    `UPDATE order_push_deliveries
     SET status = 'failed',
         last_error = ?,
         next_attempt_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND claim_token = ?`,
    [String(errorMessage || "send failed").slice(0, 500), backoff, deliveryId, claimToken]
  );
}

async function markDeliveryGone(deliveryId, claimToken, errorMessage) {
  await query(
    `UPDATE order_push_deliveries
     SET status = 'gone',
         last_error = ?,
         next_attempt_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND claim_token = ?`,
    [String(errorMessage || "gone").slice(0, 500), deliveryId, claimToken]
  );
}

export async function processClaimedDelivery(job) {
  const active =
    job.admin_is_active === true ||
    job.admin_is_active === 1 ||
    String(job.admin_is_active) === "1";

  if (!active) {
    await markDeliveryGone(job.delivery_id, job.claim_token, "admin inactive or missing");
    return { status: "skipped_inactive_admin" };
  }

  const payload = buildOrderPushPayload({
    id: job.order_id,
    order_number: job.order_number,
    amount: job.amount,
    payment_mode: job.payment_mode,
    payment_status: job.payment_status,
  });

  try {
    await pushSender(toWebPushSubscription(job), payload);
    await markDeliverySent(job.delivery_id, job.claim_token);
    return { status: "sent" };
  } catch (error) {
    const statusCode = Number(error?.statusCode || error?.status || 0);
    if (isExpiredPushStatus(statusCode)) {
      await markDeliveryGone(job.delivery_id, job.claim_token, `push ${statusCode}`);
      await deleteSubscriptionById(job.subscription_id).catch(() => {});
      return { status: "gone", statusCode };
    }
    await markDeliveryFailed(
      job.delivery_id,
      job.claim_token,
      job.attempts,
      error?.message || "push failed"
    );
    console.error("Order push delivery failed:", {
      deliveryId: job.delivery_id,
      orderId: job.order_id,
      endpoint: safeEndpointHint(job.endpoint),
      message: String(error?.message || "push failed").slice(0, 200),
    });
    return { status: "failed", statusCode };
  }
}

export async function runOrderPushScanOnce() {
  if (!isOrderPushEnabled()) {
    return { status: "disabled" };
  }

  const ready = await ensureOrderPushTablesReady();
  if (!ready) {
    return { status: "tables_missing" };
  }

  const state = await loadOrCreateWorkerState();
  const eligible = await scanCommittedOrders(state);

  const created = [];
  for (const order of eligible) {
    try {
      const result = await createNotificationAndDeliveries(order);
      if (result.created) created.push(result);
    } catch (error) {
      console.error("Order push notification create failed:", {
        orderId: order.id,
        message: error?.message,
      });
    }
  }

  const windowRows = await loadScannedWindow(state);
  const advanced = nextWatermark(state, windowRows);
  if (
    advanced.highWatermarkId !== state.highWatermarkId ||
    new Date(advanced.highWatermarkCreatedAt).getTime() !==
      new Date(state.highWatermarkCreatedAt).getTime()
  ) {
    await persistWatermark({
      ...state,
      ...advanced,
    });
  }

  return {
    status: "ok",
    eligible: eligible.length,
    created: created.length,
    deliveriesCreated: created.reduce((sum, c) => sum + (c.deliveryCount || 0), 0),
  };
}

export async function runOrderPushDeliveryOnce() {
  if (!isOrderPushEnabled()) {
    return { status: "disabled" };
  }
  const ready = await ensureOrderPushTablesReady();
  if (!ready) {
    return { status: "tables_missing" };
  }

  const jobs = await claimDeliveryBatch();
  const results = [];
  for (const job of jobs) {
    try {
      results.push(await processClaimedDelivery(job));
    } catch (error) {
      console.error("Order push processClaimedDelivery error:", {
        deliveryId: job.delivery_id,
        message: error?.message,
      });
      results.push({ status: "error" });
    }
  }
  return { status: "ok", processed: results.length, results };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await runOrderPushScanOnce();
    await runOrderPushDeliveryOnce();
  } catch (error) {
    if (isMissingTableError(error)) {
      tablesReady = false;
      console.warn("Order push worker: tables not migrated yet");
    } else {
      console.error("Order push worker tick failed:", {
        message: error?.message,
      });
    }
  } finally {
    running = false;
  }
}

export function startOrderPushWorker() {
  if (timer) return;
  if (!isOrderPushEnabled()) {
    console.log("Order push worker not started (disabled or VAPID missing)");
    return;
  }
  const interval = orderPushScanIntervalMs();
  console.log("Order push worker starting:", {
    intervalMs: interval,
    lookbackSeconds: orderPushLookbackSeconds(),
  });
  // Initial tick shortly after boot so baseline is established without waiting
  setTimeout(() => {
    tick().catch(() => {});
  }, 3_000).unref?.();
  timer = setInterval(() => {
    tick().catch(() => {});
  }, interval);
  timer.unref?.();
}

export function stopOrderPushWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running = false;
}

/** In-memory reconciliation helpers exported for tests */
export const orderPushWorkerInternals = {
  isOrderEligibleForScan,
  nextWatermark,
  deliveryBackoffSeconds,
  isExpiredPushStatus,
  buildOrderPushPayload,
};
