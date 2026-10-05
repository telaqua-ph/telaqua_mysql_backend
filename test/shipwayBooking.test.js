import test from "node:test";
import assert from "node:assert/strict";
import { buildShipwayPayload } from "../services/shipwayPayload.js";
import { assertShipwayBookingSucceeded } from "../services/shipwayService.js";

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
});

test("Shipway success requires both booking and label-generation responses", () => {
  const booking = assertShipwayBookingSucceeded({ success: true, awb_response: { success: true, AWB: "SW123", carrier_id: "3411", shipping_url: "https://labels.example/SW123.pdf" } });
  assert.deepEqual(booking, { awb: "SW123", carrierId: "3411", labelUrl: "https://labels.example/SW123.pdf" });
  assert.throws(() => assertShipwayBookingSucceeded({ success: true, awb_response: { success: false } }), { code: "SHIPWAY_PARTIAL_OR_REJECTED" });
});
