import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_PRICE,
  buildFinancialSnapshot,
  resolveOrderPricing,
} from "../services/orderPricing.js";

test("website COD pricing ignores missing promo and uses server product price", async () => {
  const pricing = await resolveOrderPricing({ quantity: 2, promo_code: null });
  assert.equal(pricing.unit_price, PRODUCT_PRICE);
  assert.equal(pricing.total_amount, PRODUCT_PRICE * 2);
  assert.equal(pricing.discount_amount, 0);
});

test("financial snapshot GST-extracts inclusive total", () => {
  const snap = buildFinancialSnapshot({
    original_amount: 2999,
    total_amount: 2999,
  });
  assert.equal(snap.shippingAmount, 0);
  assert.equal(snap.finalTotal, 2999);
  assert.equal(snap.gstRate, 18);
  assert.ok(snap.gstAmount > 0);
  assert.ok(snap.taxableAmount > 0);
});
