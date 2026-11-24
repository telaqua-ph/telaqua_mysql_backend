import assert from "node:assert/strict";
import test from "node:test";

const {
  validatePrepaidPayment,
  assertPrepaidReferenceUnused,
  verifyRazorpayPayment,
  paymentDateValue,
  istDate,
} = await import("../services/manualPrepaidOrder.js");
const { matchActivityRoute } = await import("../services/adminActivityLog.js");

const base = { payment_reference: "632082106728", payment_method: "upi", paid_on: "2026-11-23", payment_confirmed: true };

test("valid UPI payment for the full amount", () => {
  const p = validatePrepaidPayment(base, { orderTotal: 1499, today: "2026-11-23" });
  assert.deepEqual([p.reference, p.method, p.methodLabel, p.paidOn, p.amountReceived, p.isRazorpayId], ["632082106728", "upi", "UPI / QR", "2026-11-23", 1499, false]);
});

test("Razorpay payment ids are recognised", () => {
  const p = validatePrepaidPayment({ ...base, payment_reference: "pay_U3VuJj3Y3zB9Un", payment_method: "razorpay_link" }, { orderTotal: 1499, today: "2026-11-23" });
  assert.equal(p.isRazorpayId, true);
});

test("rejects part payment, future date, bad method, bad reference and missing confirmation", () => {
  const opts = { orderTotal: 1499, today: "2026-11-23" };
  assert.throws(() => validatePrepaidPayment({ ...base, amount_received: 199 }, opts), /does not match the order total/);
  assert.throws(() => validatePrepaidPayment({ ...base, paid_on: "2026-11-24" }, opts), /future/);
  assert.throws(() => validatePrepaidPayment({ ...base, payment_method: "cash" }, opts), /Choose how the customer paid/);
  assert.throws(() => validatePrepaidPayment({ ...base, payment_reference: "12" }, opts), /transaction ID/);
  assert.throws(() => validatePrepaidPayment({ ...base, payment_confirmed: false }, opts), /Tick the box/);
});

test("duplicate reference is refused with the existing order number", async () => {
  const db = { query: async (sql) => ({ rows: /razorpay_payment_id = \?/.test(sql) && !/cod_advance/.test(sql) ? [{ order_number: "TAQ-001553" }] : [] }) };
  await assert.rejects(assertPrepaidReferenceUnused("pay_U3VuJj3Y3zB9Un", { db }), /already recorded on order TAQ-001553/);
  const clean = { query: async () => ({ rows: [] }) };
  await assertPrepaidReferenceUnused("632082106728", { db: clean });
});

test("Razorpay check: captured and full amount only", async () => {
  const client = (payment) => ({ payments: { fetch: async () => payment } });
  assert.equal(await verifyRazorpayPayment("pay_X", 1499, { client: client({ status: "captured", amount: 149900, method: "upi" }) }), "upi");
  await assert.rejects(verifyRazorpayPayment("pay_X", 1499, { client: client({ status: "failed", amount: 149900 }) }), /not captured/);
  await assert.rejects(verifyRazorpayPayment("pay_X", 1499, { client: client({ status: "captured", amount: 19900 }) }), /order total is ₹1499/);
  await assert.rejects(verifyRazorpayPayment("pay_X", 1499, { client: { payments: { fetch: async () => { throw new Error("404"); } } } }), /Could not find payment/);
});

test("payment date: today = now, earlier day = noon IST", () => {
  assert.equal(paymentDateValue("2026-11-23", "2026-11-23"), null);
  assert.equal(paymentDateValue("2026-11-20", "2026-11-23"), "2026-11-20 06:30:00");
  assert.match(istDate(new Date("2026-11-23T20:00:00Z")), /^2026-11-24$/);
});

test("activity log names the action", () => {
  assert.equal(matchActivityRoute("POST", "/orders/manual-prepaid").action, "prepaid_order_added");
});
