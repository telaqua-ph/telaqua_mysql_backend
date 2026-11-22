import assert from "node:assert/strict";
import test from "node:test";

const {
  matchActivityRoute,
  diffRows,
  diffRowSets,
  sanitizeBody,
  orderIdFromResponse,
  canViewActivityLog,
  istDateRangeToUtc,
  buildSummary,
} = await import("../services/adminActivityLog.js");

test("delivery status change on an order is matched to the order", () => {
  const r = matchActivityRoute("PATCH", "/orders/1550/shipment-status");
  assert.equal(r.action, "delivery_status_changed");
  assert.equal(r.match[1], "1550");
  assert.equal(r.orderFrom, "path");
});

test("COD paid, payment/order update, delete and manual COD are logged", () => {
  assert.equal(matchActivityRoute("PATCH", "/orders/12/cod-payment").action, "cod_marked_paid");
  assert.equal(matchActivityRoute("PATCH", "/orders/cod-payment/bulk").action, "cod_paid_bulk");
  assert.equal(matchActivityRoute("PUT", "/orders/12").action, "order_updated");
  assert.equal(matchActivityRoute("DELETE", "/orders/12").action, "order_deleted");
  assert.equal(matchActivityRoute("POST", "/orders/manual-cod").orderFrom, "response");
  assert.equal(matchActivityRoute("PATCH", "/orders/12/purchased-on").action, "purchased_on_changed");
});

test("noise is skipped and unknown changes still get logged", () => {
  assert.equal(matchActivityRoute("POST", "/orders/12/mark-seen").skip, true);
  assert.equal(matchActivityRoute("POST", "/auth/login").skip, true);
  assert.equal(matchActivityRoute("POST", "/admin/logistics/shipments/track-active").skip, true);
  assert.equal(matchActivityRoute("POST", "/admin/logistics/indiapost/orders/9/tracking/refresh").skip, true);
  assert.equal(matchActivityRoute("POST", "/something/new").action, "other_change");
});

test("shipment and inventory routes", () => {
  assert.equal(matchActivityRoute("PUT", "/admin/logistics/shipments/345").orderFrom, "shipment");
  assert.equal(matchActivityRoute("POST", "/admin/logistics/indiapost/orders/9/shipment").action, "india_post_booked");
  assert.equal(matchActivityRoute("POST", "/inventory/add-stock").action, "stock_added");
  assert.equal(matchActivityRoute("PATCH", "/inventory/telaqua-ph-meter/threshold").action, "stock_threshold_changed");
});

test("diffRows lists old -> new and ignores timestamps and equal numbers", () => {
  const changes = diffRows(
    { id: 1, payment_status: "pending", fulfillment_status: "unfulfilled", total: "1799.00", updated_at: "a" },
    { id: 1, payment_status: "paid", fulfillment_status: "in_transit", total: "1799", updated_at: "b" }
  );
  assert.deepEqual(changes.map((c) => [c.field, c.from, c.to]), [
    ["payment_status", "pending", "paid"],
    ["fulfillment_status", "unfulfilled", "in_transit"],
  ]);
  assert.equal(changes[1].label, "Delivery status");
});

test("diffRowSets reports created, changed and deleted rows", () => {
  const changes = diffRowSets(
    [{ id: 1, current_stock: 238 }, { id: 2, current_stock: 5 }],
    [{ id: 1, current_stock: 237 }, { id: 3, current_stock: 1 }],
    "Inventory"
  );
  assert.deepEqual(changes.map((c) => [c.label, c.from, c.to]), [
    ["Inventory #1 · Stock", "238", "237"],
    ["Inventory #3", null, "created"],
    ["Inventory #2", "existed", "deleted"],
  ]);
});

test("sanitizeBody hides secrets", () => {
  const text = sanitizeBody({ status: "delivered", password: "x", newPassword: "y", nested: { api_key: "z" } });
  assert.match(text, /delivered/);
  assert.doesNotMatch(text, /"x"|"y"|"z"/);
  assert.equal(sanitizeBody({}), null);
});

test("orderIdFromResponse finds the created order", () => {
  assert.equal(orderIdFromResponse({ success: true, data: { id: 1551 } }), 1551);
  assert.equal(orderIdFromResponse({ data: { order: { id: 7 } } }), 7);
  assert.equal(orderIdFromResponse({ success: true }), null);
});

test("viewer list: empty means everyone, otherwise email or id", () => {
  assert.equal(canViewActivityLog({ id: 5, email: "a@b.c" }, ""), true);
  assert.equal(canViewActivityLog({ id: 3, email: "vamsi@aquaprana.ai" }, "VAMSI@aquaprana.ai, 1"), true);
  assert.equal(canViewActivityLog({ id: 1, email: "x@y.z" }, "vamsi@aquaprana.ai,1"), true);
  assert.equal(canViewActivityLog({ id: 9, email: "emp@aquaprana.ai" }, "vamsi@aquaprana.ai,1"), false);
});

test("IST date filter converts to UTC", () => {
  const { fromUtc, toUtc } = istDateRangeToUtc("2026-11-22", "2026-11-22");
  assert.equal(fromUtc, "2026-11-21 18:30:00.000");
  assert.equal(toUtc, "2026-11-22 18:29:59.999");
  assert.deepEqual(istDateRangeToUtc("bad", null), { fromUtc: null, toUtc: null });
});

test("summary text", () => {
  assert.equal(
    buildSummary("Changed delivery status", [{ label: "Delivery status", from: "unfulfilled", to: "delivered" }]),
    "Changed delivery status — Delivery status: unfulfilled → delivered"
  );
  assert.equal(buildSummary("Added stock", []), "Added stock");
});
