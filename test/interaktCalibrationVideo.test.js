import assert from "node:assert/strict";
import test from "node:test";

import {
  calibrationGreetingName,
  getCalibrationTemplateConfig,
  sendCalibrationVideoWhatsApp,
} from "../services/interaktCalibrationVideoService.js";

test("calibration greeting uses the customer name", () => {
  assert.equal(calibrationGreetingName("Guntti vamshi"), "Guntti vamshi");
  assert.equal(calibrationGreetingName("  "), "Customer");
  assert.equal(calibrationGreetingName(""), "Customer");
});

test("calibration template defaults to the approved marketing template", () => {
  const originalEnabled = process.env.INTERAKT_CALIBRATION_ENABLED;
  const originalName = process.env.INTERAKT_CALIBRATION_TEMPLATE_NAME;
  const originalLang = process.env.INTERAKT_CALIBRATION_TEMPLATE_LANGUAGE;
  const originalConsent = process.env.INTERAKT_CALIBRATION_REQUIRE_CONSENT;
  try {
    delete process.env.INTERAKT_CALIBRATION_ENABLED;
    delete process.env.INTERAKT_CALIBRATION_TEMPLATE_NAME;
    delete process.env.INTERAKT_CALIBRATION_TEMPLATE_LANGUAGE;
    delete process.env.INTERAKT_CALIBRATION_REQUIRE_CONSENT;
    assert.deepEqual(getCalibrationTemplateConfig(), {
      enabled: true,
      requireConsent: false,
      templateName: "telaqua_calibration_video",
      languageCode: "en",
    });
  } finally {
    if (originalEnabled === undefined) delete process.env.INTERAKT_CALIBRATION_ENABLED;
    else process.env.INTERAKT_CALIBRATION_ENABLED = originalEnabled;
    if (originalName === undefined) delete process.env.INTERAKT_CALIBRATION_TEMPLATE_NAME;
    else process.env.INTERAKT_CALIBRATION_TEMPLATE_NAME = originalName;
    if (originalLang === undefined) delete process.env.INTERAKT_CALIBRATION_TEMPLATE_LANGUAGE;
    else process.env.INTERAKT_CALIBRATION_TEMPLATE_LANGUAGE = originalLang;
    if (originalConsent === undefined) delete process.env.INTERAKT_CALIBRATION_REQUIRE_CONSENT;
    else process.env.INTERAKT_CALIBRATION_REQUIRE_CONSENT = originalConsent;
  }
});

test("calibration video skips test orders, bad phones, and a missing order number", async () => {
  const testOrder = await sendCalibrationVideoWhatsApp({
    customerName: "Ravi",
    customerPhone: "9876543210",
    orderId: "TAQ-001333",
    isTestOrder: 1,
  });
  assert.equal(testOrder.skipped, true);
  assert.equal(testOrder.reason, "test_order");

  const badPhone = await sendCalibrationVideoWhatsApp({
    customerName: "Ravi",
    customerPhone: "123",
    orderId: "TAQ-001333",
  });
  assert.equal(badPhone.reason, "invalid_phone");

  const missing = await sendCalibrationVideoWhatsApp({
    customerName: "Ravi",
    customerPhone: "9876543210",
    orderId: "",
  });
  assert.equal(missing.reason, "missing_order_id");
});

test("calibration video stays off when the Hostinger switch is false", async () => {
  const original = process.env.INTERAKT_CALIBRATION_ENABLED;
  process.env.INTERAKT_CALIBRATION_ENABLED = "false";
  try {
    const result = await sendCalibrationVideoWhatsApp({
      customerName: "Ravi",
      customerPhone: "9876543210",
      orderId: "TAQ-001333",
    });
    assert.equal(result.reason, "disabled");
  } finally {
    if (original === undefined) delete process.env.INTERAKT_CALIBRATION_ENABLED;
    else process.env.INTERAKT_CALIBRATION_ENABLED = original;
  }
});
