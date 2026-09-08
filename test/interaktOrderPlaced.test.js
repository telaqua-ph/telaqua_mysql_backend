import assert from "node:assert/strict";
import test from "node:test";

import {
  formatOrderAmount,
  getOrderPlacedTemplateConfig,
  sendOrderPlacedWhatsApp,
} from "../services/interaktOrderPlacedService.js";

test("formatOrderAmount omits rupee and whole-rupee decimals", () => {
  assert.equal(formatOrderAmount(1799), "1799");
  assert.equal(formatOrderAmount("2249.00"), "2249");
  assert.equal(formatOrderAmount(1799.5), "1799.50");
  assert.equal(formatOrderAmount("₹1799"), "");
  assert.equal(formatOrderAmount(null), "");
});

test("order placed template defaults to approved utility name", () => {
  const originalName = process.env.INTERAKT_ORDER_PLACED_TEMPLATE_NAME;
  const originalLang = process.env.INTERAKT_ORDER_PLACED_TEMPLATE_LANGUAGE;
  try {
    delete process.env.INTERAKT_ORDER_PLACED_TEMPLATE_NAME;
    delete process.env.INTERAKT_ORDER_PLACED_TEMPLATE_LANGUAGE;
    assert.deepEqual(getOrderPlacedTemplateConfig(), {
      templateName: "order_placed_confirmation",
      languageCode: "en",
    });
  } finally {
    if (originalName === undefined) delete process.env.INTERAKT_ORDER_PLACED_TEMPLATE_NAME;
    else process.env.INTERAKT_ORDER_PLACED_TEMPLATE_NAME = originalName;
    if (originalLang === undefined) delete process.env.INTERAKT_ORDER_PLACED_TEMPLATE_LANGUAGE;
    else process.env.INTERAKT_ORDER_PLACED_TEMPLATE_LANGUAGE = originalLang;
  }
});

test("invalid or missing phone skips WhatsApp without throwing", async () => {
  const missing = await sendOrderPlacedWhatsApp({
    customerName: "Govind",
    customerPhone: "",
    orderId: "TAQ-000123",
    orderAmount: 1799,
  });
  assert.equal(missing.skipped, true);
  assert.equal(missing.reason, "invalid_phone");

  const bad = await sendOrderPlacedWhatsApp({
    customerName: "Govind",
    customerPhone: "123",
    orderId: "TAQ-000123",
    orderAmount: 1799,
  });
  assert.equal(bad.skipped, true);
  assert.equal(bad.reason, "invalid_phone");
});

test("test orders are skipped", async () => {
  const result = await sendOrderPlacedWhatsApp({
    customerName: "Govind",
    customerPhone: "9876543210",
    orderId: "TAQ-000123",
    orderAmount: 1,
    isTestOrder: 1,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "test_order");
});

test("missing order ID skips WhatsApp", async () => {
  const result = await sendOrderPlacedWhatsApp({
    customerName: "Govind",
    customerPhone: "9876543210",
    orderId: "",
    orderAmount: 1799,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "missing_order_id");
});
