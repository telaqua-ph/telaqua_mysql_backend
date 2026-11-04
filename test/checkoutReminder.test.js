import assert from "node:assert/strict";
import test from "node:test";

import { extractFirstName } from "../services/interaktCheckoutReminderService.js";
import {
  isEligibleCodLead,
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

test("COD leads on the Leads page are due after the reminder delay", () => {
  const original = process.env.CHECKOUT_REMINDER_DELAY_MINUTES;
  const now = Date.parse("2026-11-04T10:00:00Z");
  const oldEnough = new Date(now - 31 * 60 * 1000);
  const tooSoon = new Date(now - 5 * 60 * 1000);
  const lead = {
    id: 107,
    status: "created",
    customer_name: "Tadana Vamsi Krishna",
    phone: "6302862346",
    updated_at: oldEnough,
  };
  try {
    delete process.env.CHECKOUT_REMINDER_DELAY_MINUTES;
    assert.equal(isEligibleCodLead(lead, now), true);
    assert.equal(isEligibleCodLead({ ...lead, updated_at: tooSoon }, now), false);
    assert.equal(isEligibleCodLead({ ...lead, status: "failed" }, now), true);
    assert.equal(isEligibleCodLead({ ...lead, status: "dismissed" }, now), false);
    assert.equal(isEligibleCodLead({ ...lead, customer_name: "  " }, now), false);
    assert.equal(isEligibleCodLead({ ...lead, phone: "12345" }, now), false);
    assert.equal(isEligibleCodLead({ ...lead, order_id: 12 }, now), false);
  } finally {
    if (original === undefined) delete process.env.CHECKOUT_REMINDER_DELAY_MINUTES;
    else process.env.CHECKOUT_REMINDER_DELAY_MINUTES = original;
  }
});
