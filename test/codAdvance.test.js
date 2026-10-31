import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pool } from "../config/db.js";
import {
  COD_ADVANCE_FEE_PAISE,
  checkCodAdvancePayment,
  codAdvanceBreakdown,
  createCodAdvanceCheckout,
  finalizeCodAdvancePayment,
  isCodAdvanceFeeRequired,
  markCodAdvanceFailed,
  setCodAdvanceRazorpayClientForTests,
} from "../services/codAdvanceService.js";
import { verifyCodAdvancePayment } from "../controllers/codAdvanceController.js";
import { createWebsiteCodOrder } from "../controllers/orderController.js";
import { PRODUCT_PRICE } from "../services/orderPricing.js";

process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";

const orderData = {
  customer_name: "Asha Rao", phone: "9876543210", email: "9876543210@guest.tel-aqua.in",
  address: "12 Lake Road", city: "Bengaluru", state: "Karnataka", pincode: "560001",
  quantity: 1, promo_code: null, whatsapp_updates_consent: false, whatsapp_consent_at: null,
};

/** In-memory stand-in for the two tables the COD advance flow touches. */
function fakeDb() {
  const db = { attempts: [], orders: [], nextAttemptId: 1, nextOrderId: 500 };
  const run = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s)) return { rows: [] };
    if (s.startsWith("INSERT INTO cod_advance_payments")) {
      const row = {
        id: db.nextAttemptId++, razorpay_order_id: null, razorpay_payment_id: null,
        amount_paise: params[0], status: "created", checkout_payload: params[1],
        product_amount: String(params[2]), declaration_accepted_at: new Date(), order_id: null,
      };
      db.attempts.push(row);
      return { rows: [], insertId: row.id, rowCount: 1 };
    }
    if (s.startsWith("UPDATE cod_advance_payments SET razorpay_order_id")) {
      db.attempts.find((a) => a.id === params[1]).razorpay_order_id = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("SELECT * FROM cod_advance_payments WHERE razorpay_order_id")) {
      return { rows: db.attempts.filter((a) => a.razorpay_order_id === params[0]).map((a) => ({ ...a })) };
    }
    if (s.startsWith("SELECT * FROM cod_advance_payments WHERE id")) {
      return { rows: db.attempts.filter((a) => a.id === params[0]).map((a) => ({ ...a })) };
    }
    if (s.includes("SET status = 'paid_order_failed'")) {
      Object.assign(db.attempts.find((a) => a.id === params[2]), { status: "paid_order_failed", razorpay_payment_id: params[0], failure_reason: params[1] });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("SET status = 'order_created'")) {
      Object.assign(db.attempts.find((a) => a.id === params[2]), { status: "order_created", order_id: params[0], razorpay_payment_id: params[1] });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("SET status = 'failed'")) {
      const row = db.attempts.find((a) => a.razorpay_order_id === params[1] && a.status === "created");
      if (row) Object.assign(row, { status: "failed", failure_reason: params[0] });
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith("INSERT INTO orders")) {
      const id = db.nextOrderId++;
      db.orders.push({
        id, final_total: params[9], total_amount: params[9], payment_mode: "cod", payment_status: "Pending",
        order_status: "Confirmed", cod_advance_fee: params[21], cod_advance_status: "paid",
        cod_advance_razorpay_order_id: params[22], cod_advance_razorpay_payment_id: params[23],
        cod_amount_due: params[24],
      });
      return { rows: [], insertId: id, rowCount: 1 };
    }
    if (s.startsWith("UPDATE orders SET order_number")) {
      Object.assign(db.orders.find((o) => o.id === params[2]), { order_number: params[0], invoice_access_token_hash: params[1] });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("SELECT * FROM orders WHERE id")) {
      return { rows: db.orders.filter((o) => o.id === params[0]).map((o) => ({ ...o })) };
    }
    return { rows: [], rowCount: 0 };
  };
  db.client = { query: run, release() {} };
  db.query = run;
  return db;
}

function fakeRazorpay({ orderAmount = COD_ADVANCE_FEE_PAISE, payment = {} } = {}) {
  let counter = 0;
  return {
    orders: {
      create: async (opts) => ({ id: `order_adv_${++counter}`, amount: opts.amount, currency: opts.currency }),
      fetch: async (id) => ({ id, amount: orderAmount }),
      fetchPayments: async (id) => ({ items: [{ id: "pay_adv_1", order_id: id, amount: COD_ADVANCE_FEE_PAISE, currency: "INR", status: "captured", ...payment }] }),
    },
    payments: {
      fetch: async (id) => ({ id, order_id: "order_adv_1", amount: COD_ADVANCE_FEE_PAISE, currency: "INR", status: "captured", ...payment }),
    },
  };
}

async function withHarness(db, razorpay, body) {
  const saved = { connect: pool.connect, query: pool.query, warn: console.warn, info: console.info, error: console.error, log: console.log };
  pool.connect = async () => db.client;
  pool.query = db.query;
  setCodAdvanceRazorpayClientForTests(() => razorpay);
  console.warn = console.info = console.error = console.log = () => {};
  try {
    await body();
  } finally {
    Object.assign(pool, { connect: saved.connect, query: saved.query });
    setCodAdvanceRazorpayClientForTests(null);
    Object.assign(console, { warn: saved.warn, info: saved.info, error: saved.error, log: saved.log });
  }
}

const startCheckout = () => createCodAdvanceCheckout({ orderData, productAmount: PRODUCT_PRICE, invoiceAccessHash: "hash" });

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const sign = (orderId, paymentId) => crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");

test("breakdown: ₹99 now, product amount on delivery, total = product + ₹99", () => {
  assert.deepEqual(codAdvanceBreakdown(1799), {
    product_amount: 1799, advance_fee: 99, pay_now: 99, pay_on_delivery: 1799, total_order_value: 1898,
  });
});

test("advance fee is required unless explicitly disabled", () => {
  delete process.env.COD_ADVANCE_FEE_ENABLED;
  assert.equal(isCodAdvanceFeeRequired(), true);
  process.env.COD_ADVANCE_FEE_ENABLED = "false";
  assert.equal(isCodAdvanceFeeRequired(), false);
  delete process.env.COD_ADVANCE_FEE_ENABLED;
});

test("payment check rejects wrong amount, wrong order, failed and uncaptured payments", () => {
  const ok = { amount: 9900, currency: "INR", order_id: "order_x", status: "captured" };
  assert.equal(checkCodAdvancePayment({ rzOrder: { amount: 9900 }, rzPayment: ok, razorpayOrderId: "order_x" }).ok, true);
  assert.match(checkCodAdvancePayment({ rzOrder: { amount: 100 }, rzPayment: ok, razorpayOrderId: "order_x" }).reason, /order amount/);
  assert.match(checkCodAdvancePayment({ rzOrder: { amount: 9900 }, rzPayment: { ...ok, amount: 100 }, razorpayOrderId: "order_x" }).reason, /Payment amount/);
  assert.match(checkCodAdvancePayment({ rzOrder: { amount: 9900 }, rzPayment: ok, razorpayOrderId: "order_y" }).reason, /does not belong/);
  assert.equal(checkCodAdvancePayment({ rzOrder: { amount: 9900 }, rzPayment: { ...ok, status: "failed" }, razorpayOrderId: "order_x" }).failed, true);
  assert.match(checkCodAdvancePayment({ rzOrder: { amount: 9900 }, rzPayment: { ...ok, status: "authorized" }, razorpayOrderId: "order_x" }).reason, /captured/);
});

test("checkout creates a ₹99 Razorpay order and no order row", async () => {
  const db = fakeDb();
  await withHarness(db, fakeRazorpay(), async () => {
    const { razorpayOrder } = await startCheckout();
    assert.equal(razorpayOrder.amount, 9900);
    assert.equal(db.attempts[0].razorpay_order_id, razorpayOrder.id);
    assert.equal(db.orders.length, 0);
  });
});

test("verified payment creates exactly one COD order; repeat callbacks return the same order", async () => {
  const db = fakeDb();
  await withHarness(db, fakeRazorpay(), async () => {
    const { razorpayOrder } = await startCheckout();
    const first = await finalizeCodAdvancePayment({ razorpayOrderId: razorpayOrder.id, razorpayPaymentId: "pay_adv_1" });
    const again = await finalizeCodAdvancePayment({ razorpayOrderId: razorpayOrder.id, razorpayPaymentId: "pay_adv_1" });
    const webhook = await finalizeCodAdvancePayment({ razorpayOrderId: razorpayOrder.id, source: "webhook" });
    assert.equal(first.status, "created");
    assert.equal(again.status, "already_created");
    assert.equal(webhook.status, "already_created");
    assert.equal(db.orders.length, 1);
    const order = db.orders[0];
    assert.equal(order.payment_status, "Pending", "the ₹99 advance must not mark the order fully paid");
    assert.equal(Number(order.cod_amount_due), PRODUCT_PRICE, "COD due excludes the ₹99 already paid");
    assert.equal(Number(order.cod_advance_fee), 99);
    assert.equal(order.cod_advance_razorpay_payment_id, "pay_adv_1");
    assert.equal(db.attempts[0].status, "order_created");
  });
});

test("wrong payment amount is rejected and creates no order", async () => {
  const db = fakeDb();
  await withHarness(db, fakeRazorpay({ payment: { amount: 100 } }), async () => {
    const { razorpayOrder } = await startCheckout();
    const result = await finalizeCodAdvancePayment({ razorpayOrderId: razorpayOrder.id, razorpayPaymentId: "pay_adv_1" });
    assert.equal(result.status, "payment_invalid");
    assert.equal(db.orders.length, 0);
  });
});

test("failed payment marks the attempt failed and creates no order", async () => {
  const db = fakeDb();
  await withHarness(db, fakeRazorpay({ payment: { status: "failed" } }), async () => {
    const { razorpayOrder } = await startCheckout();
    const result = await finalizeCodAdvancePayment({ razorpayOrderId: razorpayOrder.id, razorpayPaymentId: "pay_adv_1" });
    assert.equal(result.status, "payment_invalid");
    assert.equal(db.attempts[0].status, "failed");
    assert.equal(db.orders.length, 0);
  });
});

test("cancelled checkout (payment.failed webhook) never creates an order", async () => {
  const db = fakeDb();
  await withHarness(db, fakeRazorpay(), async () => {
    const { razorpayOrder } = await startCheckout();
    await markCodAdvanceFailed(razorpayOrder.id, "cancelled");
    assert.equal(db.attempts[0].status, "failed");
    assert.equal(db.orders.length, 0);
  });
});

test("price change after payment keeps the payment on record for recovery and creates no order", async () => {
  const db = fakeDb();
  await withHarness(db, fakeRazorpay(), async () => {
    await createCodAdvanceCheckout({ orderData, productAmount: PRODUCT_PRICE - 100, invoiceAccessHash: "hash" });
    const result = await finalizeCodAdvancePayment({ razorpayOrderId: db.attempts[0].razorpay_order_id, razorpayPaymentId: "pay_adv_1" });
    assert.equal(result.status, "order_failed");
    assert.match(result.reason, /price changed/i);
    assert.equal(db.attempts[0].status, "paid_order_failed");
    assert.equal(db.attempts[0].razorpay_payment_id, "pay_adv_1");
    assert.equal(db.orders.length, 0);
  });
});

test("verify endpoint rejects an invalid Razorpay signature", async () => {
  const db = fakeDb();
  await withHarness(db, fakeRazorpay(), async () => {
    const { razorpayOrder } = await startCheckout();
    const res = mockRes();
    await verifyCodAdvancePayment({ body: { razorpay_order_id: razorpayOrder.id, razorpay_payment_id: "pay_adv_1", razorpay_signature: "bad" } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(db.orders.length, 0);
  });
});

test("verify endpoint with a valid signature returns the order and payment breakdown", async () => {
  const db = fakeDb();
  await withHarness(db, fakeRazorpay(), async () => {
    const { razorpayOrder } = await startCheckout();
    const res = mockRes();
    await verifyCodAdvancePayment({ body: {
      razorpay_order_id: razorpayOrder.id,
      razorpay_payment_id: "pay_adv_1",
      razorpay_signature: sign(razorpayOrder.id, "pay_adv_1"),
    } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.order_number, "TAQ-000500");
    assert.equal(res.body.pay_now, 99);
    assert.equal(res.body.pay_on_delivery, PRODUCT_PRICE);
    assert.equal(res.body.total_order_value, PRODUCT_PRICE + 99);
  });
});

test("website COD endpoint is open without the advance and validates the body", async () => {
  const res = mockRes();
  await createWebsiteCodOrder({ body: { customer_name: "x" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});
