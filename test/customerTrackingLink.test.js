/**
 * My Account -> Track order must open the Shipway page for Shipway shipments
 * (AWB stored in shipments.waybill_number), and keep Delhivery for legacy AWBs.
 *
 * Needs module mocking: node --experimental-test-module-mocks --test test/customerTrackingLink.test.js
 * (skipped automatically when that flag is not set, e.g. plain `npm test`).
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";

if (typeof mock.module !== "function") {
  test("customer tracking link (needs --experimental-test-module-mocks)", (t) => t.skip("module mocks not enabled"));
} else {
  await runSuite();
}

async function runSuite() {
  let order = null;
  let shipment = null;
  const query = async (sql) => {
    const text = String(sql);
    if (/FROM orders/i.test(text)) return { rows: order ? [order] : [], rowCount: order ? 1 : 0 };
    if (/FROM shipments/i.test(text)) {
      assert.match(text, /provider/, "shipment lookup must include provider");
      return { rows: shipment ? [shipment] : [], rowCount: shipment ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  mock.module("../config/db.js", { namedExports: { query, pool: { query, connect: async () => ({ query, release() {} }) } } });
  const { trackCustomerOrder } = await import("../controllers/customerAccountController.js");

  const call = async () => {
    const res = { statusCode: 0, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    await trackCustomerOrder({ params: { orderId: "1235" }, customer: { phone: "9876543210" } }, res);
    return res;
  };

  test("Shipway shipment: AWB from shipments table, Shipway tracking page", async () => {
    order = { id: 1235, order_number: "TAQ-001235", waybill: null, shipment_status: null };
    shipment = { order_id: 1235, waybill_number: "SMMC1003902898", provider: "Shipway", shipment_status: "In Transit", shipment_created_at: "2026-10-29" };
    const res = await call();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.tracking.available, true);
    assert.equal(res.body.tracking.awb, "SMMC1003902898");
    assert.equal(res.body.tracking.status, "In Transit");
    assert.equal(res.body.tracking.tracking_url, "https://telaqua.shipway.com/tracking/forward/SMMC1003902898/");
  });

  test("legacy Delhivery AWB on the order keeps the Delhivery page", async () => {
    order = { id: 1235, order_number: "TAQ-000900", waybill: "1490812345678", shipment_status: "Delivered" };
    shipment = null;
    const res = await call();
    assert.equal(res.body.tracking.tracking_url, "https://www.delhivery.com/track/package/1490812345678");
  });

  test("not shipped yet: no link", async () => {
    order = { id: 1235, order_number: "TAQ-001300", waybill: null, shipment_status: null };
    shipment = { order_id: 1235, waybill_number: null, provider: "Shipway" };
    const res = await call();
    assert.equal(res.body.tracking.available, false);
    assert.equal(res.body.tracking.tracking_url, null);
  });
}
