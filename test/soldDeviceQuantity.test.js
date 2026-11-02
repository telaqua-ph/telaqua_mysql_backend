import test from "node:test";
import assert from "node:assert/strict";
import { resolveSoldDevices } from "../services/soldDeviceQuantity.js";
import { buildSwipePayload } from "../services/invoiceService.js";

test("one meter at the sale price stays quantity 1", () => {
  assert.deepEqual(
    resolveSoldDevices({ quantity: 1, unit_price: "1799.00", total_amount: "1799.00", final_total: "1799.00" }),
    { quantity: 1, unitPrice: 1799 }
  );
});

test("two meters already stored as quantity 2 stay quantity 2", () => {
  assert.deepEqual(
    resolveSoldDevices({ quantity: 2, unit_price: "1799.00", total_amount: "3598.00", final_total: "3598.00" }),
    { quantity: 2, unitPrice: 1799 }
  );
});

test("₹3598 stored as one unit is two meters at ₹1799", () => {
  assert.deepEqual(
    resolveSoldDevices({ quantity: 1, unit_price: "3598.00", total_amount: "3598.00", final_total: "3598.00" }),
    { quantity: 2, unitPrice: 1799 }
  );
});

test("a different unit price is not split", () => {
  assert.deepEqual(
    resolveSoldDevices({ quantity: 1, unit_price: "2124.00", total_amount: "2124.00", final_total: "2124.00" }),
    { quantity: 1, unitPrice: 2124 }
  );
});

test("invoice line uses the device count when the amount is two meters", () => {
  const payload = buildSwipePayload({
    id: 1297,
    order_number: "TAQ-001297",
    customer_name: "Rama manna",
    phone: "9348180252",
    email: "9348180252@guest.tel-aqua.in",
    address: "Ajagara",
    city: "Kendrapara",
    state: "Odisha",
    pincode: "754248",
    quantity: 1,
    unit_price: "3598.00",
    total_amount: "3598.00",
    final_total: "3598.00",
    taxable_amount: "3598.00",
    gst_amount: "0.00",
    gst_rate: 18,
    shipping_amount: 0,
    payment_method: "cod",
    payment_mode: "cod",
    payment_status: "Pending",
    is_test_order: false,
  });
  assert.equal(payload.items[0].quantity, 2);
  assert.equal(payload.items[0].total_amount, 3598);
});
