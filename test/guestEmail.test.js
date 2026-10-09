import test from "node:test";
import assert from "node:assert/strict";
import {
  generateGuestEmail,
  normalizePhoneForGuestEmail,
  resolveOrderEmail,
} from "../utils/guestEmail.js";

test("keeps a supplied email after trimming it", () => {
  assert.equal(resolveOrderEmail(" customer@gmail.com ", "6302862346"), "customer@gmail.com");
});

test("generates a guest email for empty, whitespace, null, and undefined email", () => {
  for (const email of ["", "   ", null, undefined]) {
    assert.equal(resolveOrderEmail(email, "6302862346"), "6302862346@guest.tel-aqua.in");
  }
});

test("normalizes Indian phone formatting and country code for guest email", () => {
  assert.equal(normalizePhoneForGuestEmail("+91 6302862346"), "6302862346");
  assert.equal(generateGuestEmail("+91 (630) 286-2346"), "6302862346@guest.tel-aqua.in");
  assert.equal(generateGuestEmail("0 6302-862346"), "6302862346@guest.tel-aqua.in");
  assert.equal(generateGuestEmail("+91 95530 07411"), "9553007411@guest.tel-aqua.in");
  assert.equal(generateGuestEmail("95530-07411"), "9553007411@guest.tel-aqua.in");
});

test("does not fabricate a guest email when there is no phone number", () => {
  assert.equal(generateGuestEmail(null), null);
  assert.equal(resolveOrderEmail("", undefined), null);
});
