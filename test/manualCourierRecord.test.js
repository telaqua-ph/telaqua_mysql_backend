import assert from "node:assert/strict";
import test from "node:test";

const {
  validateCourierInput,
  statusAfterRecording,
  shipmentStatusLabel,
  shouldNotifyCustomer,
  recordCourierForOrder,
} = await import("../services/manualCourierRecord.js");
const { matchActivityRoute } = await import("../services/adminActivityLog.js");

test("India Post needs a real article number", () => {
  const ok = validateCourierInput({ courier: "India Post", number: " en 618265248 in " });
  assert.equal(ok.option.provider, "IndiaPost");
  assert.equal(ok.number, "EN618265248IN");
  assert.equal(ok.courierName, "India Post Speed Post");
  assert.throws(() => validateCourierInput({ courier: "indiapost", number: "12345" }), /article number/);
});

test("Shipway / Delhivery take an AWB and an optional courier name", () => {
  const s = validateCourierInput({ courier: "shipway", number: "1490823456789", courierName: "Ekart" });
  assert.equal(s.option.provider, "Shipway");
  assert.equal(s.courierName, "Ekart");
  assert.equal(validateCourierInput({ courier: "Delhivery", number: "ab12345" }).number, "AB12345");
  assert.throws(() => validateCourierInput({ courier: "bluedart", number: "123456" }), /Choose the courier/);
  assert.throws(() => validateCourierInput({ courier: "shipway", number: "12" }), /valid AWB/);
});

test("delivery status is kept when already shipped or delivered", () => {
  assert.equal(statusAfterRecording("unfulfilled"), "ready_to_ship");
  assert.equal(statusAfterRecording(null), "ready_to_ship");
  assert.equal(statusAfterRecording("delivered"), "delivered");
  assert.equal(statusAfterRecording("in_transit"), "in_transit");
  assert.equal(statusAfterRecording("rto"), "rto");
  assert.equal(shipmentStatusLabel("ready_to_ship"), "Booked");
  assert.equal(shipmentStatusLabel("in_transit"), "In Transit");
});

test("customer is messaged only when asked and not yet delivered", () => {
  assert.equal(shouldNotifyCustomer(true, "ready_to_ship"), true);
  assert.equal(shouldNotifyCustomer(true, "delivered"), false);
  assert.equal(shouldNotifyCustomer(false, "in_transit"), false);
  assert.equal(shouldNotifyCustomer(undefined, "ready_to_ship"), false);
});

test("activity log names the action", () => {
  const r = matchActivityRoute("POST", "/admin/logistics/orders/1549/courier-record");
  assert.equal(r.action, "courier_recorded");
  assert.equal(r.match[1], "1549");
});

/** Minimal fake DB that records the SQL it was given. */
function fakeDb({ order, shipment = null, duplicate = null }) {
  const calls = [];
  let current = shipment ? { ...shipment } : null;
  const handle = async (sql, params = []) => {
    calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    if (/^SELECT \* FROM orders/.test(sql)) return { rows: order ? [order] : [] };
    if (/SELECT order_id FROM shipments WHERE waybill_number/.test(sql)) return { rows: duplicate ? [duplicate] : [] };
    if (/SELECT \* FROM shipments WHERE order_id/.test(sql)) return { rows: current ? [current] : [] };
    if (/^INSERT INTO shipments/.test(sql.trim())) { current = { id: 900, order_id: order.id }; return { rows: [], insertId: 900 }; }
    if (/SELECT \* FROM shipments WHERE id/.test(sql)) return { rows: [current] };
    return { rows: [], rowCount: 1 };
  };
  return {
    calls,
    async connect() { return { query: handle, release() {} }; },
    query: handle,
  };
}

test("records India Post on a delivered order without changing it to Ready to ship", async () => {
  const db = fakeDb({ order: { id: 1549, fulfillment_status: "delivered", order_status: "Confirmed" } });
  let notified = false;
  const result = await recordCourierForOrder(1549, { courier: "indiapost", number: "EN618265248IN", notify: true, actorId: 3 }, { db, notifyFn: () => { notified = true; } });
  assert.equal(result.fulfillmentStatus, "delivered");
  assert.equal(result.notified, false);
  assert.equal(notified, false);
  const update = db.calls.find((c) => c.sql.startsWith("UPDATE shipments SET provider"));
  assert.deepEqual(update.params.slice(0, 5), ["IndiaPost", "India Post Speed Post", "EN618265248IN", "delivered", "Delivered"]);
  assert.equal(db.calls.some((c) => c.sql.startsWith("UPDATE orders SET fulfillment_status")), false);
});

test("unshipped order becomes Ready to ship and can notify the customer", async () => {
  const db = fakeDb({ order: { id: 1552, fulfillment_status: "unfulfilled" } });
  let notifiedId = null;
  const result = await recordCourierForOrder(1552, { courier: "indiapost", number: "EN618265999IN", notify: true }, { db, notifyFn: (id) => { notifiedId = id; } });
  assert.equal(result.fulfillmentStatus, "ready_to_ship");
  assert.equal(notifiedId, 900);
  assert.ok(db.calls.some((c) => c.sql.startsWith("UPDATE orders SET fulfillment_status") && c.params[0] === "ready_to_ship"));
});

test("refuses an order that already has an AWB, a duplicate number, or a cancelled order", async () => {
  await assert.rejects(
    recordCourierForOrder(1, { courier: "indiapost", number: "EN618265248IN" }, { db: fakeDb({ order: { id: 1 }, shipment: { id: 5, waybill_number: "EN111111111IN", provider: "IndiaPost" } }) }),
    /already has/
  );
  await assert.rejects(
    recordCourierForOrder(1, { courier: "indiapost", number: "EN618265248IN" }, { db: fakeDb({ order: { id: 1 }, duplicate: { order_id: 2 } }) }),
    /another order/
  );
  await assert.rejects(
    recordCourierForOrder(1, { courier: "indiapost", number: "EN618265248IN" }, { db: fakeDb({ order: { id: 1, order_status: "Cancelled" } }) }),
    /cancelled/
  );
});
