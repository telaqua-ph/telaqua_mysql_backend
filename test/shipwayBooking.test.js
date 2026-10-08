import test from "node:test";
import assert from "node:assert/strict";
import { buildShipwayPayload } from "../services/shipwayPayload.js";
import { assertShipwayBookingSucceeded, createShipwayShipment, findShipwayOrder, getShipwayCarriers, isDefinitiveShipwayBookingRejection, resolveShipwayCarrier } from "../services/shipwayService.js";
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

test("Shipway payload includes only a valid supplied carrier_id", () => {
  assert.equal(buildShipwayPayload(order, product, { carrierId: "3411" }).carrier_id, 3411);
  for (const carrierId of ["", "0", "-5", "12.5", "abc", "99999999999999999999"]) {
    assert.equal(Object.hasOwn(buildShipwayPayload(order, product, { carrierId }), "carrier_id"), false);
  }
});

test("Shipway booking POST contains the resolved carrier_id", async () => {
  const prior = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, request) => {
    requests += 1;
    assert.equal(JSON.parse(request.body).carrier_id, 3411);
    return new Response(JSON.stringify({ success: false, message: "No Courier Found." }), { status: 200 });
  };
  const payload = buildShipwayPayload(order, product, { carrierId: "3411" });
  await assert.rejects(() => createShipwayShipment(payload), { code: "SHIPWAY_PARTIAL_OR_REJECTED" });
  assert.equal(requests, 1);
  globalThis.fetch = prior;
});

test("Shipway carrier lookup and resolution use active carrier IDs only", async () => {
  const prior = globalThis.fetch;
  const priorCarrier = env.SHIPWAY_CARRIER_ID;
  const requests = [];
  globalThis.fetch = async (url, request) => {
    requests.push({ url: String(url), request });
    return new Response(JSON.stringify({ success: 1, error: "", message: [
      { id: "18708", name: "Sequel Logistics", carrier_title: "Sequel" },
      { id: "3411", name: "Delhivery", carrier_title: "Delhivery Surface" },
      { id: "bad", name: "Ignored" },
    ] }), { status: 200 });
  };
  try {
    assert.deepEqual(await getShipwayCarriers(), [
      { id: "18708", name: "Sequel Logistics", title: "Sequel" },
      { id: "3411", name: "Delhivery", title: "Delhivery Surface" },
    ]);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/api\/getcarrier$/);
    assert.match(requests[0].request.headers.Authorization, /^Basic /);
    assert.deepEqual(await resolveShipwayCarrier(), { carrierId: "18708", carrierName: "Sequel Logistics", source: "shipway" });
    env.SHIPWAY_CARRIER_ID = "3411";
    assert.deepEqual(await resolveShipwayCarrier(), { carrierId: "3411", carrierName: "Delhivery", source: "configured" });
    env.SHIPWAY_CARRIER_ID = "999";
    await assert.rejects(() => resolveShipwayCarrier(), { code: "SHIPWAY_CONFIG_ERROR" });
  } finally {
    if (priorCarrier === undefined) delete env.SHIPWAY_CARRIER_ID; else env.SHIPWAY_CARRIER_ID = priorCarrier;
    globalThis.fetch = prior;
  }
});

test("carrier lookup reports no carriers, HTTP failures, and network errors safely", async () => {
  const prior = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ success: 1, message: "No carrier found" }), { status: 200 });
    await assert.rejects(() => resolveShipwayCarrier(), { code: "SHIPWAY_NO_CARRIER" });
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
    await assert.rejects(() => getShipwayCarriers(), { code: "SHIPWAY_CARRIER_LOOKUP_FAILED" });
    globalThis.fetch = async () => { throw new Error("offline"); };
    await assert.rejects(() => getShipwayCarriers(), { code: "SHIPWAY_CARRIER_LOOKUP_FAILED" });
  } finally { globalThis.fetch = prior; }
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
