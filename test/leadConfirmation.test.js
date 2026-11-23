import assert from "node:assert/strict";
import test from "node:test";

const {
  normalizePaymentReference,
  normalizeManualMethod,
  manualAdvanceSplit,
  isUnpaidOnlineLead,
  confirmOnlineLead,
  confirmCodLead,
} = await import("../services/leadConfirmation.js");
const { matchActivityRoute } = await import("../services/adminActivityLog.js");

test("payment reference: UTR and UPI ids accepted, junk rejected", () => {
  assert.equal(normalizePaymentReference(" 6320 8210 6728 "), "632082106728");
  assert.equal(normalizePaymentReference("vamsi@okaxis"), "vamsi@okaxis");
  assert.throws(() => normalizePaymentReference("12"), /transaction ID/);
  assert.throws(() => normalizePaymentReference("abc<script>"), /transaction ID/);
  assert.throws(() => normalizePaymentReference(""), /transaction ID/);
});

test("payment method defaults to UPI", () => {
  assert.equal(normalizeManualMethod("BANK_TRANSFER"), "bank_transfer");
  assert.equal(normalizeManualMethod("cash"), "upi");
  assert.equal(normalizeManualMethod(undefined), "upi");
});

test("₹199 per unit is deducted from the total, max 3 units", () => {
  assert.deepEqual(manualAdvanceSplit(1799, 1), { total: 1799, advance: 199, due: 1600 });
  assert.deepEqual(manualAdvanceSplit(3598, 2), { total: 3598, advance: 398, due: 3200 });
  assert.deepEqual(manualAdvanceSplit(7196, 4), { total: 7196, advance: 597, due: 6599 });
});

test("only unpaid non-COD orders are online leads", () => {
  assert.equal(isUnpaidOnlineLead({ payment_mode: "razorpay", payment_status: "Pending" }), true);
  assert.equal(isUnpaidOnlineLead({ payment_mode: "razorpay", payment_status: "Failed" }), true);
  assert.equal(isUnpaidOnlineLead({ payment_mode: "razorpay", payment_status: "Paid" }), false);
  assert.equal(isUnpaidOnlineLead({ payment_mode: "cod", payment_status: "Pending" }), false);
});

test("activity log records lead confirmation", () => {
  assert.equal(matchActivityRoute("POST", "/orders/leads/confirm").action, "lead_confirmed");
});

/** Fake DB for the online-lead flow. */
function fakeDb({ order, usedRef = false, stock = 50 }) {
  const calls = [];
  const handle = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    calls.push({ sql: s, params });
    if (s.startsWith("SELECT order_number FROM orders WHERE cod_advance_razorpay_payment_id")) return { rows: usedRef ? [{ order_number: "TAQ-000001" }] : [] };
    if (s.startsWith("SELECT id FROM cod_advance_payments WHERE razorpay_payment_id")) return { rows: [] };
    if (s.startsWith("SELECT * FROM orders WHERE id")) return { rows: order ? [order] : [] };
    if (s.startsWith("SELECT id FROM inventory_history")) return { rows: [] };
    if (s.startsWith("SELECT * FROM inventory WHERE sku")) return { rows: [{ id: 1, sku: "telaqua-ph-meter", current_stock: stock, low_stock_threshold: 5 }] };
    return { rows: [], rowCount: 1 };
  };
  return { calls, query: handle, async connect() { return { query: handle, release() {} }; } };
}

const onlineOrder = { id: 1551, order_number: "TAQ-001551", payment_mode: "razorpay", payment_status: "Failed", final_total: "1799.00", quantity: 1, customer_name: "P sri sandeep", phone: "9999999999" };

test("online lead becomes a COD order with ₹199 paid and ₹1600 due, stock deducted", async () => {
  const db = fakeDb({ order: onlineOrder });
  let afterArgs = null;
  const result = await confirmOnlineLead(1551, { reference: "632082106728", actorId: 3 }, { db, after: (a) => { afterArgs = a; } });
  assert.deepEqual([result.advance, result.due, result.orderNumber], [199, 1600, "TAQ-001551"]);
  const update = db.calls.find((c) => c.sql.startsWith("UPDATE orders SET payment_mode = 'cod'"));
  assert.deepEqual(update.params, [199, "632082106728", 1600, 1551]);
  assert.ok(db.calls.some((c) => c.sql.startsWith("UPDATE inventory SET current_stock") && c.params[0] === 49));
  assert.ok(db.calls.some((c) => c.sql.startsWith("INSERT INTO cod_payment_audit_log") && c.params[1] === 3));
  assert.equal(afterArgs.orderNumber, "TAQ-001551");
});

test("refuses a reused reference, a paid order, and no stock", async () => {
  await assert.rejects(confirmOnlineLead(1551, { reference: "632082106728" }, { db: fakeDb({ order: onlineOrder, usedRef: true }), after() {} }), /already recorded on order TAQ-000001/);
  await assert.rejects(confirmOnlineLead(1551, { reference: "632082106728" }, { db: fakeDb({ order: { ...onlineOrder, payment_status: "Paid" } }), after() {} }), /not an unpaid online lead/);
  await assert.rejects(confirmOnlineLead(1551, { reference: "632082106728" }, { db: fakeDb({ order: onlineOrder, stock: 0 }), after() {} }), /Not enough stock/);
});

test("COD lead rejects unknown source and bad ids before touching the database", async () => {
  await assert.rejects(confirmCodLead(5, { source: "other", reference: "632082106728" }, { db: fakeDb({}) }), /Unknown lead type/);
  await assert.rejects(confirmCodLead("x", { reference: "632082106728" }, { db: fakeDb({}) }), /Invalid lead/);
});
