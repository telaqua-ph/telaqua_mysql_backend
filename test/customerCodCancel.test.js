import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCustomerCodCancel,
  hasBlockingShipment,
  isCustomerCodCancellable,
} from "../services/customerCodCancel.js";

test("eligible COD New/Confirmed/Processing orders can be cancelled", () => {
  for (const order_status of ["New", "Confirmed", "Processing"]) {
    const result = evaluateCustomerCodCancel({
      payment_mode: "cod",
      order_status,
    });
    assert.equal(result.ok, true, order_status);
    assert.equal(
      isCustomerCodCancellable({ payment_mode: "cod", order_status }),
      true
    );
  }
  assert.equal(
    isCustomerCodCancellable({
      payment_mode: "cod",
      payment_method: "cod",
      order_status: "",
    }),
    true
  );
});

test("Razorpay and other online orders are rejected", () => {
  for (const order of [
    { payment_mode: "razorpay", order_status: "New" },
    { payment_method: "Razorpay", order_status: "New" },
    { payment_method: "upi", order_status: "Confirmed" },
    { payment_mode: "razorpay", payment_method: "cod", order_status: "New" },
  ]) {
    const result = evaluateCustomerCodCancel(order);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.message, "Only Cash on Delivery orders can be cancelled.");
  }
});

test("already Cancelled COD orders cannot be cancelled again", () => {
  const result = evaluateCustomerCodCancel({
    payment_mode: "cod",
    order_status: "Cancelled",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "ALREADY_CANCELLED");
});

test("Delivered and Completed COD orders cannot be cancelled", () => {
  for (const order_status of ["Delivered", "Completed"]) {
    const result = evaluateCustomerCodCancel({
      payment_mode: "cod",
      order_status,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(result.code, "NOT_ELIGIBLE");
  }
});

test("Shipped COD orders cannot be cancelled", () => {
  const result = evaluateCustomerCodCancel({
    payment_mode: "cod",
    order_status: "Shipped",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "SHIPPED");
  assert.match(result.message, /already been shipped/);
});

test("AWB, Delhivery shipment id, or shipment created blocks cancel", () => {
  const base = { payment_mode: "cod", order_status: "New" };
  assert.equal(hasBlockingShipment({ ...base, waybill: "123456789012" }), true);
  assert.equal(
    hasBlockingShipment({ ...base, delhivery_shipment_id: "SHIP-1" }),
    true
  );
  assert.equal(
    hasBlockingShipment({ ...base, shipment_created_at: "2026-08-26 10:00:00" }),
    true
  );
  assert.equal(
    hasBlockingShipment({ ...base, pickup_requested_at: "2026-08-26 10:00:00" }),
    true
  );
  assert.equal(
    evaluateCustomerCodCancel({ ...base, tracking_number: "987654321" }).code,
    "SHIPPED"
  );
  assert.equal(
    evaluateCustomerCodCancel(base, { waybill_number: "123456789012" }).code,
    "SHIPPED"
  );
  assert.equal(
    evaluateCustomerCodCancel(base, { shipment_id: "DLV-9" }).code,
    "SHIPPED"
  );
  assert.equal(
    evaluateCustomerCodCancel(base, { shipment_created_at: "2026-08-26 10:00:00" }).code,
    "SHIPPED"
  );
});

test("shipment Created status blocks cancel even without a display AWB", () => {
  const result = evaluateCustomerCodCancel({
    payment_mode: "cod",
    order_status: "Processing",
    shipment_status: "Created",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "SHIPPED");
});

test("unfulfilled empty shipment data does not block New COD", () => {
  assert.equal(
    hasBlockingShipment({
      payment_mode: "cod",
      order_status: "New",
      shipment_status: "Not Created",
    }),
    false
  );
  assert.equal(
    isCustomerCodCancellable({
      payment_mode: "cod",
      payment_method: "cod",
      order_status: "New",
      waybill: null,
      shipment_status: "",
    }),
    true
  );
});

test("Paid COD remains cancellable until shipment starts", () => {
  assert.equal(
    isCustomerCodCancellable({
      payment_mode: "cod",
      payment_status: "Paid",
      order_status: "Confirmed",
    }),
    true
  );
});

test("repeat cancel of an already Cancelled order is rejected (no duplicate processing)", () => {
  const first = evaluateCustomerCodCancel({
    payment_mode: "cod",
    order_status: "New",
  });
  assert.equal(first.ok, true);
  const second = evaluateCustomerCodCancel({
    payment_mode: "cod",
    order_status: "Cancelled",
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, "ALREADY_CANCELLED");
});
