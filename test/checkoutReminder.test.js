import assert from "node:assert/strict";
import test from "node:test";

import { extractFirstName } from "../services/interaktCheckoutReminderService.js";
import {
  isEligibleOnlineCheckoutOrder,
  isPaidOrTerminalOrder,
  reminderDelayMinutes,
} from "../services/checkoutReminderService.js";

test("extractFirstName uses the first token", () => {
  assert.equal(extractFirstName("Govind Baddi"), "Govind");
  assert.equal(extractFirstName("  Anita  "), "Anita");
  assert.equal(extractFirstName(""), "");
});

test("reminderDelayMinutes defaults to 30 when env is missing or invalid", () => {
  const original = process.env.CHECKOUT_REMINDER_DELAY_MINUTES;
  try {
    delete process.env.CHECKOUT_REMINDER_DELAY_MINUTES;
    assert.equal(reminderDelayMinutes(), 30);
    process.env.CHECKOUT_REMINDER_DELAY_MINUTES = "abc";
    assert.equal(reminderDelayMinutes(), 30);
    process.env.CHECKOUT_REMINDER_DELAY_MINUTES = "45";
    assert.equal(reminderDelayMinutes(), 45);
  } finally {
    if (original === undefined) delete process.env.CHECKOUT_REMINDER_DELAY_MINUTES;
    else process.env.CHECKOUT_REMINDER_DELAY_MINUTES = original;
  }
});

test("Paid, Cancelled, Delivered, Completed, COD, and test orders are ineligible", () => {
  assert.equal(isPaidOrTerminalOrder({ payment_status: "Paid" }), true);
  assert.equal(isPaidOrTerminalOrder({ order_status: "Cancelled" }), true);
  assert.equal(isPaidOrTerminalOrder({ order_status: "Delivered" }), true);
  assert.equal(isPaidOrTerminalOrder({ order_status: "Completed" }), true);
  assert.equal(
    isEligibleOnlineCheckoutOrder({
      payment_mode: "cod",
      payment_status: "Failed",
    }),
    false
  );
  assert.equal(
    isEligibleOnlineCheckoutOrder({
      payment_mode: "razorpay",
      payment_status: "Failed",
      is_test_order: 1,
    }),
    false
  );
  assert.equal(
    isEligibleOnlineCheckoutOrder({
      payment_mode: "razorpay",
      payment_status: "Failed",
      order_status: "New",
    }),
    true
  );
  assert.equal(
    isEligibleOnlineCheckoutOrder({
      payment_mode: "razorpay",
      payment_status: "Paid",
    }),
    false
  );
});
