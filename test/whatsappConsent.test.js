import test from "node:test";
import assert from "node:assert/strict";
import { parseWhatsappConsent } from "../services/whatsappConsent.js";

test("parseWhatsappConsent: missing field defaults to false", () => {
  const result = parseWhatsappConsent({});
  assert.equal(result.whatsapp_updates_consent, false);
  assert.equal(result.whatsapp_consent_at, null);
  assert.equal(result.error, undefined);
});

test("parseWhatsappConsent: boolean true sets consent and timestamp", () => {
  const before = Date.now();
  const result = parseWhatsappConsent({ whatsapp_updates_consent: true });
  const after = Date.now();
  assert.equal(result.whatsapp_updates_consent, true);
  assert.ok(result.whatsapp_consent_at instanceof Date);
  assert.ok(result.whatsapp_consent_at.getTime() >= before);
  assert.ok(result.whatsapp_consent_at.getTime() <= after);
});

test("parseWhatsappConsent: boolean false stays false", () => {
  const result = parseWhatsappConsent({ whatsapp_updates_consent: false });
  assert.equal(result.whatsapp_updates_consent, false);
  assert.equal(result.whatsapp_consent_at, null);
});

test('parseWhatsappConsent: string "true" / "false"', () => {
  assert.equal(
    parseWhatsappConsent({ whatsapp_updates_consent: "true" }).whatsapp_updates_consent,
    true
  );
  assert.equal(
    parseWhatsappConsent({ whatsapp_updates_consent: "TRUE" }).whatsapp_updates_consent,
    true
  );
  assert.equal(
    parseWhatsappConsent({ whatsapp_updates_consent: "false" }).whatsapp_updates_consent,
    false
  );
  assert.equal(
    parseWhatsappConsent({ whatsapp_updates_consent: "false" }).whatsapp_consent_at,
    null
  );
});

test("parseWhatsappConsent: number 1 / 0", () => {
  assert.equal(
    parseWhatsappConsent({ whatsapp_updates_consent: 1 }).whatsapp_updates_consent,
    true
  );
  assert.ok(
    parseWhatsappConsent({ whatsapp_updates_consent: 1 }).whatsapp_consent_at instanceof Date
  );
  assert.equal(
    parseWhatsappConsent({ whatsapp_updates_consent: 0 }).whatsapp_updates_consent,
    false
  );
});

test("parseWhatsappConsent: string yes/no and 1/0", () => {
  assert.equal(
    parseWhatsappConsent({ whatsapp_updates_consent: "yes" }).whatsapp_updates_consent,
    true
  );
  assert.equal(
    parseWhatsappConsent({ whatsapp_updates_consent: "1" }).whatsapp_updates_consent,
    true
  );
  assert.equal(
    parseWhatsappConsent({ whatsapp_updates_consent: "no" }).whatsapp_updates_consent,
    false
  );
  assert.equal(
    parseWhatsappConsent({ whatsapp_updates_consent: "0" }).whatsapp_updates_consent,
    false
  );
});

test("parseWhatsappConsent: alias keys (first match wins)", () => {
  assert.equal(
    parseWhatsappConsent({ whatsappConsent: true }).whatsapp_updates_consent,
    true
  );
  assert.equal(
    parseWhatsappConsent({ whatsapp_consent: "true" }).whatsapp_updates_consent,
    true
  );
  assert.equal(
    parseWhatsappConsent({ receiveWhatsappUpdates: 1 }).whatsapp_updates_consent,
    true
  );
  // Canonical wins over later aliases
  assert.equal(
    parseWhatsappConsent({
      whatsapp_updates_consent: false,
      whatsappConsent: true,
    }).whatsapp_updates_consent,
    false
  );
});

test("parseWhatsappConsent: null body or null value → false", () => {
  assert.equal(parseWhatsappConsent(null).whatsapp_updates_consent, false);
  assert.equal(
    parseWhatsappConsent({ whatsapp_updates_consent: null }).whatsapp_updates_consent,
    false
  );
});
