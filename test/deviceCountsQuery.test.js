import test from "node:test";
import assert from "node:assert/strict";
import { buildDeviceCountsQuery } from "../controllers/dashboardController.js";

test("device-count aggregate is CTE-free for MariaDB prepared statements", () => {
  const { sql, params } = buildDeviceCountsQuery({
    columns: new Set([
      "id", "quantity", "payment_mode", "payment_method", "payment_status",
      "order_status", "created_at", "payment_date", "is_test_order",
      "fulfillment_status", "shipment_status", "purchased_on",
    ]),
    includeShipmentsTable: true,
    includeInventoryHistory: true,
    from: "2026-10-28",
    to: "2026-10-31",
    now: new Date("2026-11-20T00:00:00.000Z"),
  });

  assert.doesNotMatch(sql, /\bWITH\b/i);
  assert.match(sql, /FROM orders o\s+LEFT JOIN shipments s ON s\.order_id = o\.id AND s\.sequence_no = 1/i);
  assert.match(sql, /SUM\(CASE WHEN/i);
  assert.deepEqual(params, ["2026-10-28", "2026-10-28", "2026-10-31", "2026-10-31"]);
});
