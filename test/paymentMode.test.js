import assert from "node:assert/strict";
import test from "node:test";

import {
  canFulfillOrder,
  isCodOrder,
  normalizePaymentMode,
  withNormalizedPaymentMode,
} from "../services/paymentMode.js";

test("normalizePaymentMode defaults existing online orders to razorpay", () => {
  assert.equal(normalizePaymentMode({ payment_method: "Razorpay" }), "razorpay");
  assert.equal(normalizePaymentMode({ payment_method: "upi" }), "razorpay");
  assert.equal(normalizePaymentMode({ payment_method: "card" }), "razorpay");
  assert.equal(normalizePaymentMode({ payment_mode: "razorpay" }), "razorpay");
});

test("normalizePaymentMode classifies explicit COD data as cod", () => {
  assert.equal(normalizePaymentMode({ payment_mode: "cod" }), "cod");
  assert.equal(normalizePaymentMode({ payment_method: "cod" }), "cod");
  assert.equal(
    normalizePaymentMode({ payment_method: "cash on delivery" }),
    "cod"
  );
  assert.equal(
    normalizePaymentMode({ payment_method: "cash_on_delivery" }),
    "cod"
  );
});

test("payment_mode column wins over payment_method", () => {
  assert.equal(
    normalizePaymentMode({ payment_mode: "cod", payment_method: "Razorpay" }),
    "cod"
  );
  assert.equal(
    normalizePaymentMode({ payment_mode: "razorpay", payment_method: "cod" }),
    "razorpay"
  );
});

test("withNormalizedPaymentMode always returns razorpay or cod", () => {
  const order = withNormalizedPaymentMode({ payment_method: "upi" });
  assert.equal(order.payment_mode, "razorpay");
  assert.equal(isCodOrder(order), false);
});

test("Razorpay/prepaid orders can be fulfilled only when Paid", () => {
  assert.equal(
    canFulfillOrder({ payment_mode: "razorpay", payment_status: "Pending" }),
    false
  );
  assert.equal(
    canFulfillOrder({ payment_mode: "razorpay", payment_status: "Paid" }),
    true
  );
});

test("COD orders can be fulfilled while Pending or Paid", () => {
  assert.equal(
    canFulfillOrder({ payment_mode: "cod", payment_status: "Pending" }),
    true
  );
  assert.equal(
    canFulfillOrder({ payment_mode: "cod", payment_status: "Paid" }),
    true
  );
  assert.equal(
    canFulfillOrder({ payment_mode: "cod", payment_status: "Failed" }),
    false
  );
});
