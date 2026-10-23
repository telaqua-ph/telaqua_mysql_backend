import assert from "node:assert/strict";
import test from "node:test";

import { countUniqueCustomersByCoupon, customerKey } from "../services/couponUsageService.js";

test("customer key uses normalized phone, then email, never name", () => {
  assert.equal(customerKey({ phone: "+91 98765-43210" }), "phone:9876543210");
  assert.equal(customerKey({ phone: "09876543210" }), "phone:9876543210");
  assert.equal(customerKey({ phone: "", email: " A@B.com " }), "email:a@b.com");
  assert.equal(customerKey({ customer_name: "Ravi" }), null);
});

test("each customer counts once per coupon, and once under each different coupon", () => {
  const counts = countUniqueCustomersByCoupon([
    { promo_code: "fn40", phone: "9876543210" },
    { promo_code: "FN40 ", phone: "+919876543210" }, // same customer, second order
    { promo_code: "FN40", phone: "9123456789" },
    { promo_code: "TA40", phone: "9876543210" }, // same customer, other coupon
    { promo_code: "", phone: "9000000000" }, // no coupon
    { promo_code: "TA40", phone: "", email: "" }, // unidentifiable
  ]);
  assert.equal(counts.get("FN40"), 2);
  assert.equal(counts.get("TA40"), 1);
  assert.equal(counts.get("DURGA50"), undefined); // list handler shows 0
});
