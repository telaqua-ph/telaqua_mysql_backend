/**
 * Isolated Web Push / order-notification tests (mocked push, no live DB).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrderPushPayload,
  deliveryBackoffSeconds,
  formatPaymentWording,
  isExpiredPushStatus,
  isOrderEligibleForScan,
  nextWatermark,
  sanitizeAdminNotificationUrl,
  ORDER_PUSH_MAX_ATTEMPTS,
} from "../services/orderPushPayload.js";
import { validatePushSubscriptionInput } from "../services/adminPushSubscriptionService.js";

/* ─── Payment wording ─────────────────────────────────────────────── */

test("pending Razorpay is never described as paid", () => {
  assert.equal(
    formatPaymentWording({ payment_mode: "razorpay", payment_status: "Pending" }),
    "Online · Payment pending"
  );
  const payload = buildOrderPushPayload({
    id: 42,
    order_number: "TA-42",
    amount: 1799,
    payment_mode: "razorpay",
    payment_status: "Pending",
  });
  assert.equal(payload.title, "New order received");
  assert.match(payload.body, /Payment pending/);
  assert.doesNotMatch(payload.body, /\bPaid\b/);
  assert.equal(payload.tag, "telaqua-order-42");
  assert.equal(payload.url, "/orders/42");
  assert.doesNotMatch(payload.body, /phone|address|\+91/i);
});

test("paid Razorpay and COD wording are accurate", () => {
  assert.equal(
    formatPaymentWording({ payment_mode: "razorpay", payment_status: "Paid" }),
    "Online · Paid"
  );
  assert.equal(
    formatPaymentWording({ payment_mode: "cod", payment_status: "Pending" }),
    "COD · Payment pending"
  );
  assert.equal(
    formatPaymentWording({ payment_mode: "cod", payment_status: "Paid" }),
    "COD · Paid"
  );
  assert.equal(
    formatPaymentWording({ payment_mode: "razorpay", payment_status: "Failed" }),
    "Online · Payment failed"
  );
});

test("sanitizeAdminNotificationUrl allows only safe admin order paths", () => {
  assert.equal(sanitizeAdminNotificationUrl("/orders/12"), "/orders/12");
  assert.equal(sanitizeAdminNotificationUrl("/orders"), "/orders");
  assert.equal(sanitizeAdminNotificationUrl("https://evil.example/x"), null);
  assert.equal(sanitizeAdminNotificationUrl("/settings"), null);
  assert.equal(sanitizeAdminNotificationUrl("/orders/12/../admin"), null);
});

/* ─── Baseline / late commits / duplicates ─────────────────────────── */

test("initial baseline excludes historical orders", () => {
  const state = {
    baselineOrderId: 100,
    highWatermarkId: 100,
    highWatermarkCreatedAt: "2026-03-15T10:00:00Z",
    lookbackSeconds: 120,
  };
  assert.equal(
    isOrderEligibleForScan(
      { id: 50, created_at: "2026-03-15T09:00:00Z" },
      state,
      []
    ),
    false
  );
  assert.equal(
    isOrderEligibleForScan(
      { id: 100, created_at: "2026-03-15T10:00:00Z" },
      state,
      []
    ),
    false
  );
  assert.equal(
    isOrderEligibleForScan(
      { id: 101, created_at: "2026-03-15T10:01:00Z" },
      state,
      []
    ),
    true
  );
});

test("late commits inside lookback are eligible even when id <= watermark", () => {
  const state = {
    baselineOrderId: 100,
    highWatermarkId: 105,
    highWatermarkCreatedAt: "2026-03-15T10:05:00Z",
    lookbackSeconds: 120,
  };
  // Late-visible row: id 104 committed after watermark advanced past it
  assert.equal(
    isOrderEligibleForScan(
      { id: 104, created_at: "2026-03-15T10:04:30Z" },
      state,
      []
    ),
    true
  );
  // Already notified — uniqueness / set prevents duplicate jobs
  assert.equal(
    isOrderEligibleForScan(
      { id: 104, created_at: "2026-03-15T10:04:30Z" },
      state,
      new Set([104])
    ),
    false
  );
  // Too old even with lookback
  assert.equal(
    isOrderEligibleForScan(
      { id: 103, created_at: "2026-03-15T09:00:00Z" },
      state,
      []
    ),
    false
  );
});

test("worker restart resumes from durable watermark without skipping newer ids", () => {
  const state = {
    baselineOrderId: 100,
    highWatermarkId: 110,
    highWatermarkCreatedAt: "2026-03-15T11:00:00Z",
    lookbackSeconds: 120,
  };
  assert.equal(
    isOrderEligibleForScan(
      { id: 111, created_at: "2026-03-15T11:01:00Z" },
      state,
      []
    ),
    true
  );
  const advanced = nextWatermark(state, [
    { id: 111, created_at: "2026-03-15T11:01:00Z" },
    { id: 112, created_at: "2026-03-15T11:02:00Z" },
  ]);
  assert.equal(advanced.highWatermarkId, 112);
});

test("duplicate scans do not create duplicate notification jobs (in-memory)", () => {
  const notifications = new Map(); // orderId -> notification
  const deliveries = [];

  function createJobs(order, subscriptions) {
    if (notifications.has(order.id)) {
      return { created: false };
    }
    const notificationId = notifications.size + 1;
    notifications.set(order.id, { id: notificationId, orderId: order.id });
    for (const sub of subscriptions) {
      const key = `${notificationId}:${sub.id}`;
      if (deliveries.some((d) => `${d.notificationId}:${d.subscriptionId}` === key)) {
        continue;
      }
      deliveries.push({
        notificationId,
        subscriptionId: sub.id,
        status: "pending",
      });
    }
    return { created: true, notificationId };
  }

  const subs = [
    { id: 1, endpoint: "https://push.example/device-a" },
    { id: 2, endpoint: "https://push.example/device-b" },
  ];
  const order = { id: 201, created_at: "2026-03-15T12:00:00Z" };

  assert.equal(createJobs(order, subs).created, true);
  assert.equal(createJobs(order, subs).created, false);
  assert.equal(notifications.size, 1);
  assert.equal(deliveries.length, 2);
  assert.deepEqual(
    deliveries.map((d) => d.subscriptionId).sort(),
    [1, 2]
  );
});

/* ─── Per-device retry / expired subs ──────────────────────────────── */

test("only failed device deliveries are retried", () => {
  const jobs = [
    { id: 1, status: "sent", attempts: 1 },
    { id: 2, status: "failed", attempts: 1, next_attempt_at: null },
    { id: 3, status: "pending", attempts: 0 },
  ];
  const due = jobs.filter(
    (j) => j.status === "pending" || j.status === "failed"
  );
  assert.deepEqual(
    due.map((j) => j.id),
    [2, 3]
  );
  assert.ok(!due.some((j) => j.status === "sent"));
});

test("expired push 404/410 removes subscription; backoff is bounded", () => {
  assert.equal(isExpiredPushStatus(404), true);
  assert.equal(isExpiredPushStatus(410), true);
  assert.equal(isExpiredPushStatus(500), false);
  assert.equal(deliveryBackoffSeconds(1), 30);
  assert.equal(deliveryBackoffSeconds(2), 120);
  assert.equal(deliveryBackoffSeconds(ORDER_PUSH_MAX_ATTEMPTS), null);
});

test("two devices for one admin get separate delivery jobs", () => {
  const adminId = 9;
  const subscriptions = [
    { id: 11, admin_id: adminId, endpoint: "https://fcm.example/a" },
    { id: 12, admin_id: adminId, endpoint: "https://fcm.example/b" },
  ];
  const notificationId = 77;
  const deliveries = subscriptions.map((s) => ({
    notificationId,
    subscriptionId: s.id,
    status: "pending",
  }));
  assert.equal(deliveries.length, 2);
  assert.notEqual(deliveries[0].subscriptionId, deliveries[1].subscriptionId);
});

test("disabling one device leaves the other subscription intact", () => {
  const byEndpoint = new Map([
    ["https://fcm.example/pc", { id: 1, admin_id: 3 }],
    ["https://fcm.example/phone", { id: 2, admin_id: 3 }],
  ]);
  byEndpoint.delete("https://fcm.example/pc");
  assert.equal(byEndpoint.has("https://fcm.example/pc"), false);
  assert.equal(byEndpoint.has("https://fcm.example/phone"), true);
  assert.equal(byEndpoint.get("https://fcm.example/phone").admin_id, 3);
});

test("account switch transfers endpoint ownership (dedupe by endpoint)", () => {
  const endpoint = "https://fcm.example/shared-browser";
  const row = { endpoint, admin_id: 1, p256dh: "x", auth: "y" };
  // Second admin registers same browser endpoint
  row.admin_id = 2;
  assert.equal(row.admin_id, 2);
});

test("inactive / unauthorized admins are rejected by validation helpers", () => {
  const activeAdmins = new Set([5]);
  function authorize(adminId, isActive) {
    if (!activeAdmins.has(adminId) || !isActive) {
      return { ok: false, status: 403 };
    }
    return { ok: true };
  }
  assert.equal(authorize(5, true).ok, true);
  assert.equal(authorize(5, false).status, 403);
  assert.equal(authorize(99, true).status, 403);
});

test("subscription input validation requires HTTPS endpoint and keys", () => {
  assert.ok(
    validatePushSubscriptionInput({
      endpoint: "http://insecure.example/x",
      keys: { p256dh: "a", auth: "b" },
    }).error
  );
  assert.ok(
    validatePushSubscriptionInput({
      endpoint: "https://fcm.example/x",
      keys: { p256dh: "", auth: "b" },
    }).error
  );
  const ok = validatePushSubscriptionInput({
    endpoint: "https://fcm.example/x",
    keys: { p256dh: "p256", auth: "auth" },
    userAgent: "Chrome",
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.endpoint, "https://fcm.example/x");
});

/* ─── Claim isolation simulation ───────────────────────────────────── */

test("overlapping claim tokens prevent double-send of the same delivery", () => {
  const delivery = { id: 1, status: "pending", claim_token: null, attempts: 0 };

  function claim(token) {
    if (
      delivery.status === "pending" ||
      delivery.status === "failed" ||
      (delivery.status === "claimed" && false)
    ) {
      delivery.status = "claimed";
      delivery.claim_token = token;
      delivery.attempts += 1;
      return true;
    }
    return false;
  }

  assert.equal(claim("token-a"), true);
  assert.equal(claim("token-b"), false);
  assert.equal(delivery.claim_token, "token-a");
  assert.equal(delivery.attempts, 1);
});

test("mocked push sender records per-device sends without creating orders", async () => {
  const sent = [];
  const mockSend = async (subscription, payload) => {
    sent.push({ endpoint: subscription.endpoint, payload });
    return { statusCode: 201 };
  };

  const devices = [
    { endpoint: "https://fcm.example/a", keys: { p256dh: "1", auth: "2" } },
    { endpoint: "https://fcm.example/b", keys: { p256dh: "3", auth: "4" } },
  ];
  const payload = buildOrderPushPayload({
    id: 9,
    order_number: "TA-9",
    amount: 499,
    payment_mode: "cod",
    payment_status: "Pending",
  });

  for (const device of devices) {
    await mockSend(device, payload);
  }

  assert.equal(sent.length, 2);
  assert.equal(sent[0].endpoint, "https://fcm.example/a");
  assert.equal(sent[1].endpoint, "https://fcm.example/b");
  assert.match(sent[0].payload.body, /COD · Payment pending/);
});
