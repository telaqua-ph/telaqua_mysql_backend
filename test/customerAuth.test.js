import test from "node:test";
import assert from "node:assert/strict";
import {
  generateOtp,
  getCustomerAuthConfigurationStatus,
  hashOtp,
  signCustomerToken,
  verifyCustomerToken,
  verifyOtpHash,
} from "../lib/customerAuth.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";
import { orderBelongsToCustomer } from "../services/customerAuthService.js";
import { sendOtp } from "../services/interaktOtpService.js";

const TEST_SECRET = "customer-auth-test-secret-at-least-32-characters";

test("Indian phone formats normalize to one customer identity", () => {
  for (const value of ["9876543210", "+91 98765 43210", "919876543210", "09876543210"]) {
    assert.deepEqual(normalizeIndianPhone(value), {
      countryCode: "+91",
      phoneNumber: "9876543210",
    });
  }
});

test("OTP is six digits and only its keyed salted hash verifies", () => {
  const originalSecret = process.env.CUSTOMER_AUTH_SECRET;
  process.env.CUSTOMER_AUTH_SECRET = TEST_SECRET;
  try {
    const otp = generateOtp();
    assert.match(otp, /^\d{6}$/);
    const stored = hashOtp("9876543210", otp);
    assert.doesNotMatch(stored, new RegExp(otp));
    assert.equal(verifyOtpHash("9876543210", otp, stored), true);
    assert.equal(verifyOtpHash("9876543210", "000000", stored), otp === "000000");
    assert.equal(verifyOtpHash("9123456789", otp, stored), false);
  } finally {
    if (originalSecret === undefined) delete process.env.CUSTOMER_AUTH_SECRET;
    else process.env.CUSTOMER_AUTH_SECRET = originalSecret;
  }
});

test("customer JWT is typed, scoped and includes a revocable token id", () => {
  const originalSecret = process.env.CUSTOMER_AUTH_SECRET;
  process.env.CUSTOMER_AUTH_SECRET = TEST_SECRET;
  try {
    const token = signCustomerToken({
      phone: "9876543210",
      tokenId: "991b2ca4-c323-4a22-847e-b92f6081da62",
    });
    const payload = verifyCustomerToken(token);
    assert.equal(payload.sub, "9876543210");
    assert.equal(payload.phone, "9876543210");
    assert.equal(payload.token_type, "customer");
    assert.equal(payload.jti, "991b2ca4-c323-4a22-847e-b92f6081da62");
  } finally {
    if (originalSecret === undefined) delete process.env.CUSTOMER_AUTH_SECRET;
    else process.env.CUSTOMER_AUTH_SECRET = originalSecret;
  }
});

test("an unusable dedicated customer secret safely falls back to a usable JWT secret", () => {
  const originalCustomerSecret = process.env.CUSTOMER_AUTH_SECRET;
  const originalJwtSecret = process.env.JWT_SECRET;
  process.env.CUSTOMER_AUTH_SECRET = "too-short";
  process.env.JWT_SECRET = "usable-jwt-fallback-secret-at-least-24";
  try {
    const status = getCustomerAuthConfigurationStatus();
    assert.equal(status.dedicatedSecretConfigured, true);
    assert.equal(status.dedicatedSecretUsable, false);
    assert.equal(status.jwtFallbackUsable, true);
    assert.equal(status.selectedSource, "JWT_SECRET");
    const token = signCustomerToken({
      phone: "9876543210",
      tokenId: "94a06165-1c34-4012-8008-51bdf91ff5aa",
    });
    assert.equal(verifyCustomerToken(token).phone, "9876543210");
  } finally {
    if (originalCustomerSecret === undefined) delete process.env.CUSTOMER_AUTH_SECRET;
    else process.env.CUSTOMER_AUTH_SECRET = originalCustomerSecret;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  }
});

test("order ownership uses normalized phone and rejects another customer", () => {
  assert.equal(orderBelongsToCustomer({ phone: "+91 9876543210" }, "9876543210"), true);
  assert.equal(orderBelongsToCustomer({ phone: "9123456789" }, "9876543210"), false);
});

test("Interakt OTP request uses authentication body and button values", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.INTERAKT_API_KEY;
  const originalTemplate = process.env.INTERAKT_OTP_TEMPLATE_NAME;
  let captured;
  process.env.INTERAKT_API_KEY = "test-interakt-key";
  process.env.INTERAKT_OTP_TEMPLATE_NAME = "customer_login_auth";
  globalThis.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "message-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await sendOtp("9876543210", "123456");
    assert.equal(result.messageId, "message-1");
    assert.equal(captured.phoneNumber, "9876543210");
    assert.deepEqual(captured.template.bodyValues, ["123456"]);
    assert.deepEqual(captured.template.buttonValues, { "0": ["123456"] });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.INTERAKT_API_KEY;
    else process.env.INTERAKT_API_KEY = originalKey;
    if (originalTemplate === undefined) delete process.env.INTERAKT_OTP_TEMPLATE_NAME;
    else process.env.INTERAKT_OTP_TEMPLATE_NAME = originalTemplate;
  }
});

test("preferred Interakt authentication template configuration takes precedence", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.INTERAKT_API_KEY;
  const originalPreferred = process.env.INTERAKT_AUTH_TEMPLATE_NAME;
  const originalLegacy = process.env.INTERAKT_OTP_TEMPLATE_NAME;
  let captured;
  process.env.INTERAKT_API_KEY = "test-interakt-key";
  process.env.INTERAKT_AUTH_TEMPLATE_NAME = "approved_auth_template";
  process.env.INTERAKT_OTP_TEMPLATE_NAME = "legacy_template";
  globalThis.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "message-2" }), { status: 200 });
  };
  try {
    await sendOtp("9876543210", "654321");
    assert.equal(captured.template.name, "approved_auth_template");
    assert.deepEqual(captured.template.bodyValues, ["654321"]);
    assert.deepEqual(captured.template.buttonValues, { "0": ["654321"] });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.INTERAKT_API_KEY;
    else process.env.INTERAKT_API_KEY = originalKey;
    if (originalPreferred === undefined) delete process.env.INTERAKT_AUTH_TEMPLATE_NAME;
    else process.env.INTERAKT_AUTH_TEMPLATE_NAME = originalPreferred;
    if (originalLegacy === undefined) delete process.env.INTERAKT_OTP_TEMPLATE_NAME;
    else process.env.INTERAKT_OTP_TEMPLATE_NAME = originalLegacy;
  }
});
