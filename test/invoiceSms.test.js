import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSmsVariablesValues,
  generateSmsInvoiceToken,
  hashSmsInvoiceToken,
  isFast2SmsConfigured,
  isValidSmsInvoiceToken,
  parseSmsInvoiceLinkRef,
} from "../services/invoiceSmsService.js";
import { parseInvoiceLinkRef } from "../services/invoiceWhatsAppService.js";

test("SMS token is 14 alphanumeric chars and link ref fits DLT 30-char limit", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const token = generateSmsInvoiceToken();
    assert.match(token, /^[A-Za-z0-9]{14}$/);
    seen.add(token);
  }
  assert.equal(seen.size, 200);
  assert.ok(`9999999-${generateSmsInvoiceToken()}`.length <= 30);
});

test("parseSmsInvoiceLinkRef accepts <orderId>-<14 char token> only", () => {
  assert.deepEqual(parseSmsInvoiceLinkRef("1078-k3Jf9xQa2LmPzZ"), {
    orderId: 1078,
    token: "k3Jf9xQa2LmPzZ",
  });
  assert.equal(parseSmsInvoiceLinkRef("1078-short"), null);
  assert.equal(parseSmsInvoiceLinkRef("0-k3Jf9xQa2LmPzZ"), null);
  assert.equal(parseSmsInvoiceLinkRef("abc-k3Jf9xQa2LmPzZ"), null);
  assert.equal(parseSmsInvoiceLinkRef("1078-k3Jf9xQa2LmP-Z"), null);
  assert.equal(parseSmsInvoiceLinkRef(""), null);
});

test("SMS and WhatsApp link formats never collide", () => {
  const sms = "1078-k3Jf9xQa2LmPzZ";
  const wa = `1078-${"a".repeat(64)}`;
  assert.equal(parseInvoiceLinkRef(sms), null);
  assert.equal(parseSmsInvoiceLinkRef(wa), null);
});

test("SMS token validates only against its own hash", () => {
  const token = generateSmsInvoiceToken();
  const hash = hashSmsInvoiceToken(token);
  assert.equal(isValidSmsInvoiceToken(hash, token), true);
  assert.equal(isValidSmsInvoiceToken(hash, generateSmsInvoiceToken()), false);
  assert.equal(isValidSmsInvoiceToken(null, token), false);
});

test("variables_values follow template order and DLT rules", () => {
  const order = {
    id: 1078,
    customer_name: "Tadana Vamsi Krishna",
    order_number: "TAQ-001078",
    final_total: "1799.00",
  };
  assert.equal(
    buildSmsVariablesValues(order, "1078-k3Jf9xQa2LmPzZ"),
    "Tadana|TAQ-001078|1799|1078-k3Jf9xQa2LmPzZ"
  );
  assert.equal(
    buildSmsVariablesValues({ id: 5, customer_name: "A|B", total_amount: 10.5 }, "5-x", ["name", "amount", "link"]),
    "A B|10.50|5-x"
  );
  assert.equal(
    buildSmsVariablesValues({ id: 5, customer_name: "X".repeat(40) }, "5-x", ["name"]).length,
    30
  );
});

test("Fast2SMS is configured only with API key, sender ID and message ID", () => {
  assert.equal(isFast2SmsConfigured({ apiKey: "k", senderId: "TELAQA", messageId: "123" }), true);
  assert.equal(isFast2SmsConfigured({ apiKey: "", senderId: "TELAQA", messageId: "123" }), false);
  assert.equal(isFast2SmsConfigured({ apiKey: "k", senderId: "TELAQA", messageId: "" }), false);
});
