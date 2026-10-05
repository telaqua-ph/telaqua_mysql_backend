import test from "node:test";
import assert from "node:assert/strict";
import { buildShipwayPayload } from "../services/shipwayPayload.js";
import { assertShipwayBookingSucceeded, createShipwayShipment, findShipwayOrder, isDefinitiveShipwayBookingRejection } from "../services/shipwayService.js";
import { isSafeFailedShipmentPlaceholder } from "../services/shipmentDeletionSafety.js";

const env = process.env;
env.SHIPWAY_EMAIL = "merchant@example.test";
env.SHIPWAY_LICENSE_KEY = "test-license";
env.SHIPWAY_WAREHOUSE_ID = "109177";
env.SHIPWAY_RETURN_WAREHOUSE_ID = "109177";

const product = { name: "Tel-Aqua pH Meter", weightGm: 350, lengthCm: 25, widthCm: 20, heightCm: 8 };
const order = {
  id: 42, order_number: "TAQ-000042", customer_name: "Asha Rao", phone: "9876543210",
  email: "asha@example.test", address: "12 Lake Road", city: "Bengaluru", state: "Karnataka",
  pincode: "560001", quantity: 2, unit_price: 499, final_total: 998, payment_mode: "cod",
  payment_status: "Pending", created_at: "2026-10-05T09:00:00Z",
};

test("Shipway payload uses stored order values and configured Shipway warehouses", () => {
  delete env.SHIPWAY_CARRIER_ID;
  const payload = buildShipwayPayload(order, product);
  assert.equal(payload.order_id, "TAQ-000042");
  assert.equal(payload.warehouse_id, "109177");
  assert.equal(payload.return_warehouse_id, "109177");
  assert.equal(payload.payment_type, "C");
  assert.equal(payload.products[0].product_quantity, "2");
  assert.equal(payload.products[0].price, "499");
  assert.equal(payload.order_weight, "700");
  assert.equal(payload.box_breadth, "20");
  assert.equal(Object.hasOwn(payload, "carrier_id"), false);
});

test("Shipway carrier_id is omitted unless a verified numeric value is configured", () => {
  env.SHIPWAY_CARRIER_ID = "3411";
  assert.equal(buildShipwayPayload(order, product).carrier_id, "3411");
  env.SHIPWAY_CARRIER_ID = "   ";
  assert.equal(Object.hasOwn(buildShipwayPayload(order, product), "carrier_id"), false);
  env.SHIPWAY_CARRIER_ID = "undefined";
  assert.equal(Object.hasOwn(buildShipwayPayload(order, product), "carrier_id"), false);
  env.SHIPWAY_CARRIER_ID = "Shipway-Delhivery";
  assert.equal(Object.hasOwn(buildShipwayPayload(order, product), "carrier_id"), false);
  env.SHIPWAY_CARRIER_ID = "0";
  assert.equal(Object.hasOwn(buildShipwayPayload(order, product), "carrier_id"), false);
  env.SHIPWAY_CARRIER_ID = "109177";
  assert.equal(Object.hasOwn(buildShipwayPayload(order, product), "carrier_id"), false);
  delete env.SHIPWAY_CARRIER_ID;
});

test("invalid carrier configuration is omitted and does not prevent Shipway auto-assignment", async () => {
  const prior = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, request) => {
    requests += 1;
    assert.equal(Object.hasOwn(JSON.parse(request.body), "carrier_id"), false);
    return new Response(JSON.stringify({ success: false, message: "No Courier Found." }), { status: 200 });
  };
  env.SHIPWAY_CARRIER_ID = "not-a-number";
  const payload = buildShipwayPayload(order, product);
  await assert.rejects(() => createShipwayShipment(payload), { code: "SHIPWAY_PARTIAL_OR_REJECTED" });
  assert.equal(requests, 1);
  delete env.SHIPWAY_CARRIER_ID;
  globalThis.fetch = prior;
});

test("Shipway success requires both booking and label-generation responses", () => {
  const booking = assertShipwayBookingSucceeded({ success: true, awb_response: { success: true, AWB: "SW123", carrier_id: "3411", shipping_url: "https://labels.example/SW123.pdf" } });
  assert.deepEqual(booking, { awb: "SW123", carrierId: "3411", carrierName: null, labelUrl: "https://labels.example/SW123.pdf" });
  assert.throws(() => assertShipwayBookingSucceeded({ message: "Carrier unavailable", success: true, awb_response: { success: false } }), { code: "SHIPWAY_PARTIAL_OR_REJECTED", message: /Carrier unavailable/ });
});

test("Shipway rejected booking retains its safe upstream error", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "Invalid pincode" }), { status: 422 });
  await assert.rejects(() => createShipwayShipment({ order_id: "TAQ-000873" }), { code: "SHIPWAY_UPSTREAM_ERROR", message: /Invalid pincode/ });
  globalThis.fetch = prior;
});

test("explicit no-courier rejection has no shipment artifacts and is safe to unlock", () => {
  let rejected;
  try {
    assertShipwayBookingSucceeded({ success: false, message: "carrier_id does not exist.", awb_response: "No Courier Found." });
  } catch (error) { rejected = error; }
  assert.equal(isDefinitiveShipwayBookingRejection(rejected), true);
  assert.equal(rejected.upstreamBody.awb_response, "No Courier Found.");
});

test("a rejected response without an AWB or label is safe to unlock even if success is omitted", () => {
  let rejected;
  try {
    assertShipwayBookingSucceeded({ message: "No Courier Found." });
  } catch (error) { rejected = error; }
  assert.equal(isDefinitiveShipwayBookingRejection(rejected), true);
});

test("only a failed unbooked non-Delhivery placeholder can be cleaned up", () => {
  assert.equal(isSafeFailedShipmentPlaceholder({ provider: "Shipway", courier_name: "Shipway", fulfillment_status: "unfulfilled" }), true);
  assert.equal(isSafeFailedShipmentPlaceholder({ provider: "Shipway", waybill_number: "SW123" }), false);
  assert.equal(isSafeFailedShipmentPlaceholder({ provider: "Delhivery", fulfillment_status: "unfulfilled" }), false);
  assert.equal(isSafeFailedShipmentPlaceholder({ provider: null, courier_name: "Delhivery" }), false);
});

test("Shipway lookup finds an existing AWB and label without booking again", async () => {
  const prior = globalThis.fetch;
  let calledUrl = "";
  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ orders: [{ order_id: "TAQ-000873", awb_number: "SW123", carrier_id: "3411", shipping_url: "https://labels.example/SW123.pdf" }] }), { status: 200 });
  };
  const found = await findShipwayOrder("TAQ-000873");
  assert.equal(found.state, "exists");
  assert.equal(found.awb, "SW123");
  assert.match(calledUrl, /getorders/);
  assert.doesNotMatch(calledUrl, /v2orders/);
  globalThis.fetch = prior;
});

test("Shipway lookup confirms absence before a retry can be enabled", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ orders: [] }), { status: 200 });
  const found = await findShipwayOrder("TAQ-000873");
  assert.equal(found.state, "confirmed_absent");
  globalThis.fetch = prior;
});
