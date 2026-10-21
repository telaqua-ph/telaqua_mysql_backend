import assert from "node:assert/strict";
import test from "node:test";

import { runShipwayPendingAwbSync } from "../services/shipwayTrackingSyncService.js";
import { assertShipwayBookingSucceeded } from "../services/shipwayService.js";

function fakeDb(shipments, orders) {
  const db = { shipments: new Map(shipments.map((s) => [s.id, { ...s }])), orders: new Map(orders.map((o) => [o.id, { ...o }])), audit: [] };
  db.query = async (raw, params = []) => {
    const sql = raw.replace(/\s+/g, " ").trim();
    if (/v2orders/i.test(sql)) throw new Error("must never book");
    if (/^SELECT s\.\*, o\.order_number AS shipway_order_number FROM shipments s JOIN orders o/i.test(sql)) {
      assert.match(sql, /s\.waybill_number IS NULL/);
      const rows = [...db.shipments.values()].filter((s) => !s.waybill_number && s.provider === "Shipway")
        .map((s) => ({ ...s, shipway_order_number: db.orders.get(s.order_id).order_number }));
      return { rows, rowCount: rows.length };
    }
    if (/^UPDATE shipments SET provider = 'Shipway', waybill_number = \?/i.test(sql)) {
      const [awb, courier, carrierId, label, , , , id] = params;
      const row = db.shipments.get(id);
      if (!row || row.waybill_number) return { rows: [], rowCount: 0 };
      Object.assign(row, { waybill_number: awb, courier_name: courier ?? row.courier_name, carrier_id: carrierId ?? row.carrier_id,
        shipping_label_url: label ?? row.shipping_label_url, shipment_status: "Ready to Ship", fulfillment_status: "ready_to_ship" });
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE orders SET fulfillment_status = 'ready_to_ship' WHERE id = \?/i.test(sql)) {
      db.orders.get(params[0]).fulfillment_status = "ready_to_ship"; return { rows: [], rowCount: 1 };
    }
    if (/^INSERT INTO shipment_audit_log/i.test(sql)) { db.audit.push(params[2]); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE shipments SET last_tracking_update = NOW\(\) WHERE id = \?/i.test(sql)) {
      db.shipments.get(params[0]).checked = true; return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return db;
}

const failed = (id, orderId) => ({ id, order_id: orderId, provider: "Shipway", waybill_number: null, shipment_status: "Booking Failed", fulfillment_status: "unfulfilled", processing_token: null });

test("a courier re-assigned in Shipway replaces Booking Failed with the new AWB (lookup only)", async () => {
  const db = fakeDb([failed(1, 1119), failed(2, 1140)], [
    { id: 1119, order_number: "TAQ-001119" }, { id: 1140, order_number: "TAQ-001140" },
  ]);
  const looked = [];
  const lookup = async (orderNumber) => {
    looked.push(orderNumber);
    return orderNumber === "TAQ-001119"
      ? { state: "exists", awb: "374575507272", labelUrl: "https://labels.example/374575507272.pdf", carrierId: "19339", carrierName: "Amazon Shipping Surface", body: {} }
      : { state: "exists", awb: null, labelUrl: null, body: {} };
  };
  const summary = await runShipwayPendingAwbSync({ db, lookup, env: { SHIPWAY_TRACKING_SYNC_PACE_MS: "0" } });
  assert.deepEqual(looked, ["TAQ-001119", "TAQ-001140"]);
  assert.equal(summary.saved, 1);
  const booked = db.shipments.get(1);
  assert.equal(booked.waybill_number, "374575507272");
  assert.equal(booked.shipment_status, "Ready to Ship");
  assert.equal(booked.shipping_label_url, "https://labels.example/374575507272.pdf");
  assert.equal(db.orders.get(1119).fulfillment_status, "ready_to_ship");
  assert.deepEqual(db.audit, ["shipway_awb_synced"]);
  // Still no courier in Shipway: left as is, only marked as checked.
  assert.equal(db.shipments.get(2).waybill_number, null);
  assert.equal(db.shipments.get(2).checked, true);
});

test("non-serviceable courier message tells the admin to assign another courier", () => {
  assert.throws(
    () => assertShipwayBookingSucceeded(
      { success: 1, message: "Order has been added successfully", awb_response: { success: false, message: "Amazon Shipping (carrier_id 19339) No shipping services available for recipient address. (A-306)" } },
      { orderNumber: "TAQ-001141" }
    ),
    (error) => error.shipwayOrderCreated === true && /Assign another courier to this order in Shipway/.test(error.message)
  );
});
