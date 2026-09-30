import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildMetaPurchaseBody,
  deliverMetaPurchase,
  hashMetaPhone,
  normalizeIndianMobile,
  purchaseUnixSeconds,
} from "../services/metaPurchase.js";

const NORMALIZED = "919876543210";
const HASH = createHash("sha256").update(NORMALIZED).digest("hex");

function memoryLedger() {
  const rows = new Map();
  return {
    async get(eventId) {
      return rows.get(eventId) || null;
    },
    async remember(eventId, eventTime) {
      if (!rows.has(eventId)) rows.set(eventId, { eventTime, sent: false });
    },
    async markSent(eventId) {
      const current = rows.get(eventId) || { eventTime: 0, sent: false };
      rows.set(eventId, { ...current, sent: true });
    },
  };
}

function codOrder(overrides = {}) {
  return {
    id: 14,
    order_number: "TAQ-000014",
    phone: "9876543210",
    total_amount: 1799,
    final_total: 1799,
    payment_mode: "cod",
    payment_status: "Pending",
    created_at: "2026-09-30T06:41:00.000Z",
    ...overrides,
  };
}

test("Indian mobiles normalize to digits with country code", () => {
  for (const value of ["9876543210", "+91 98765 43210", "09876543210", "919876543210"]) {
    assert.equal(normalizeIndianMobile(value), NORMALIZED, value);
  }
  assert.equal(normalizeIndianMobile(""), null);
  assert.equal(normalizeIndianMobile("12345"), null);
  assert.equal(normalizeIndianMobile("5573398770"), null);
});

test("phone hash is one lowercase SHA-256 digest and is not hashed twice", () => {
  assert.equal(hashMetaPhone(NORMALIZED), HASH);
  assert.match(HASH, /^[a-f0-9]{64}$/);
  assert.equal(hashMetaPhone(HASH), HASH);
  assert.equal(hashMetaPhone(HASH.toUpperCase()), HASH);
});

test("Purchase payload uses the order number, INR total, and hashed phone", () => {
  const order = codOrder();
  const eventTime = purchaseUnixSeconds(order);
  const body = buildMetaPurchaseBody(order, { eventId: order.order_number, eventTime });
  assert.equal(body.data[0].event_name, "Purchase");
  assert.equal(body.data[0].event_id, "TAQ-000014");
  assert.equal(body.data[0].event_time, eventTime);
  assert.equal(body.data[0].custom_data.currency, "INR");
  assert.equal(body.data[0].custom_data.value, 1799);
  assert.deepEqual(body.data[0].user_data.ph, [HASH]);
  assert.equal(JSON.stringify(body).includes("9876543210"), false);
  assert.equal(JSON.stringify(body).includes(NORMALIZED), false);
});

test("missing or invalid phones are omitted and the event is still sent", async () => {
  for (const phone of [null, "", "12345"]) {
    const bodies = [];
    const order = codOrder({ phone });
    const result = await deliverMetaPurchase(order, {
      order,
      accessToken: "test-token",
      ledger: memoryLedger(),
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, status: 200 };
      },
    });
    assert.equal(result.status, "sent");
    assert.equal(bodies[0].data[0].user_data.ph, undefined);
    assert.equal(JSON.stringify(bodies[0]).includes("12345"), false);
  }
});

test("COD and paid Razorpay purchases send once and retries keep the original time", async () => {
  const ledger = memoryLedger();
  const bodies = [];
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    bodies.push(JSON.parse(init.body));
    if (calls === 1) return { ok: false, status: 500 };
    return { ok: true, status: 200 };
  };
  const order = codOrder();
  const deps = { order, accessToken: "test-token", ledger, fetch: fetchImpl };

  const failed = await deliverMetaPurchase(order, deps);
  const sent = await deliverMetaPurchase(order, deps);
  const duplicate = await deliverMetaPurchase(order, deps);

  assert.equal(failed.status, "failed");
  assert.equal(sent.status, "sent");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(calls, 2);
  assert.equal(bodies[1].data[0].event_id, "TAQ-000014");
  assert.equal(bodies[1].data[0].event_time, bodies[0].data[0].event_time);
  assert.equal(bodies[1].data[0].event_time, purchaseUnixSeconds(order));

  const razorpayOrder = codOrder({
    order_number: "TAQ-000015",
    payment_mode: "razorpay",
    payment_status: "Paid",
    payment_date: "2026-09-30T06:45:00.000Z",
    total_amount: 2499,
    final_total: 2499,
  });
  const razorpayBodies = [];
  const razorpay = await deliverMetaPurchase(razorpayOrder, {
    order: razorpayOrder,
    accessToken: "test-token",
    ledger: memoryLedger(),
    fetch: async (_url, init) => {
      razorpayBodies.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    },
  });
  assert.equal(razorpay.status, "sent");
  assert.equal(razorpayBodies[0].data[0].event_id, "TAQ-000015");
  assert.equal(razorpayBodies[0].data[0].custom_data.value, 2499);
  assert.equal(razorpayBodies[0].data[0].custom_data.currency, "INR");
  assert.equal(razorpayBodies[0].data[0].event_time, purchaseUnixSeconds(razorpayOrder));
});

test("unpaid Razorpay orders are not sent and Meta failures do not throw", async () => {
  const pending = codOrder({
    payment_mode: "razorpay",
    payment_status: "Pending",
  });
  const unpaid = await deliverMetaPurchase(pending, {
    order: pending,
    accessToken: "super-secret-token",
    ledger: memoryLedger(),
    fetch: async () => {
      throw new Error("network down super-secret-token");
    },
  });
  assert.equal(unpaid.status, "skipped");
  assert.equal(unpaid.reason, "not_a_completed_purchase");

  const failed = await deliverMetaPurchase(codOrder(), {
    order: codOrder(),
    accessToken: "super-secret-token",
    ledger: memoryLedger(),
    fetch: async () => {
      throw new Error("network down super-secret-token");
    },
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.reason, "network");
  assert.equal(JSON.stringify(failed).includes("super-secret-token"), false);
});
