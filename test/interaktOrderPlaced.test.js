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
      bodyFields: ["name", "order_number", "amount"],
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

test("order-placed body values follow the configured template variables", async () => {
  const { buildOrderPlacedBodyValues } = await import("../services/interaktOrderPlacedService.js");
  const data = { name: "Ravi", orderId: "TAQ-001200", amount: "1799", productName: "" };
  assert.deepEqual(buildOrderPlacedBodyValues(data, ["name", "order_number", "amount"]), ["Ravi", "TAQ-001200", "1799"]);
  assert.deepEqual(
    buildOrderPlacedBodyValues(data, ["name", "product", "order_number", "amount"]),
    ["Ravi", "Tel-Aqua pH Meter", "TAQ-001200", "1799"]
  );
});

test("invoice button value is the order ref, or the full link in url mode", async () => {
  const { buildOrderPlacedButtonValue } = await import("../services/interaktOrderPlacedService.js");
  const ref = `1200-${"a".repeat(64)}`;
  assert.equal(buildOrderPlacedButtonValue(ref, "ref"), ref);
  assert.equal(
    buildOrderPlacedButtonValue(ref, "url", "https://lightpink-reindeer-561421.hostingersite.com/"),
    `https://lightpink-reindeer-561421.hostingersite.com/i/${ref}`
  );
  assert.equal(buildOrderPlacedButtonValue("", "ref"), "");
});
