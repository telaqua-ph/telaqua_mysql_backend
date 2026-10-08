import test from "node:test";
import assert from "node:assert/strict";
import { filterOrdersForExport } from "../controllers/orderController.js";

const orders = [
  { id: 1, order_number: "TAQ-1", customer_name: "A", created_at: "2026-10-01 10:00:00", order_status: "Confirmed", payment_status: "Paid", payment_mode: "razorpay" },
  { id: 2, order_number: "TAQ-2", customer_name: "B", created_at: "2026-10-03 10:00:00", order_status: "Confirmed", payment_status: "Paid", payment_mode: "cod" },
  { id: 3, order_number: "TAQ-3", customer_name: "C", created_at: "2026-10-05 10:00:00", order_status: "New", payment_status: "Pending", payment_mode: "cod" },
  { id: 4, order_number: "TAQ-4", customer_name: "D", created_at: "2026-09-30 10:00:00", order_status: "Confirmed", payment_status: "Paid", payment_mode: "razorpay" },
  { id: 5, order_number: "TAQ-5", customer_name: "E", created_at: "2026-10-06 10:00:00", order_status: "Confirmed", payment_status: "Pending", payment_mode: "cod" },
];

test("date range plus two selected IDs exports exactly those two", () => {
  const result = filterOrdersForExport(orders, {
    startDate: "2026-10-01", endDate: "2026-10-05", selectedOrderIds: ["1", "3"],
  });
  assert.deepEqual(result.map((order) => order.id), [1, 3]);
});

test("date range without a selection exports only its filtered orders", () => {
  const result = filterOrdersForExport(orders, {
    startDate: "2026-10-02", endDate: "2026-10-05", selectedOrderIds: [],
  });
  assert.deepEqual(result.map((order) => order.id), [2, 3]);
});

test("a selected ID outside the date range is not exported", () => {
  const result = filterOrdersForExport(orders, {
    startDate: "2026-10-01", endDate: "2026-10-03", selectedOrderIds: ["2", "4"],
  });
  assert.deepEqual(result.map((order) => order.id), [2]);
});

test("all time is the only mode that exports all rows", () => {
  assert.equal(filterOrdersForExport(orders, { selectedOrderIds: [] }).length, 0);
  assert.equal(filterOrdersForExport(orders, { allTime: true, selectedOrderIds: [] }).length, 5);
  assert.equal(filterOrdersForExport(orders, { startDate: "2026-10-01", endDate: "2026-10-03", selectedOrderIds: [] }).length, 2);
});

test("Razorpay failed and pending export metric excludes COD and paid Razorpay orders", () => {
  const result = filterOrdersForExport([
    { id: 1, created_at: "2026-10-01", payment_mode: "razorpay", payment_status: "Paid" },
    { id: 2, created_at: "2026-10-01", payment_mode: "razorpay", payment_status: "Pending" },
    { id: 3, created_at: "2026-10-01", payment_mode: "razorpay", payment_status: "failed" },
    { id: 4, created_at: "2026-10-01", payment_mode: "cod", payment_status: "Pending" },
  ], { metricFilter: "razorpay_failed_pending", selectedOrderIds: [] });
  assert.deepEqual(result.map((order) => order.id), [2, 3]);
});

test("total devices sold list includes paid devices and confirmed COD payment-pending orders", () => {
  const result = filterOrdersForExport(orders, {
    metricFilter: "sales_total_devices",
    selectedOrderIds: [],
  });
  assert.deepEqual(result.map((order) => order.id), [1, 2, 4, 5]);
});
