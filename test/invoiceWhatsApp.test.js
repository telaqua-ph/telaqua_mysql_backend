import assert from "node:assert/strict";
import test from "node:test";

import { buildTemplatePayload } from "../services/myOperatorService.js";
import {
  buildInvoiceTemplateBody,
  formatInvoiceAmount,
  hashInvoiceLinkToken,
  isValidInvoiceLinkToken,
  parseInvoiceLinkRef,
} from "../services/invoiceWhatsAppService.js";

const TOKEN = "a".repeat(64);

test("parseInvoiceLinkRef accepts <orderId>-<64 hex token> only", () => {
  assert.deepEqual(parseInvoiceLinkRef(`1028-${TOKEN}`), { orderId: 1028, token: TOKEN });
  assert.equal(parseInvoiceLinkRef("1028-9f3c2a7b5e1d4c8a"), null);
  assert.equal(parseInvoiceLinkRef(`abc-${TOKEN}`), null);
  assert.equal(parseInvoiceLinkRef(`0-${TOKEN}`), null);
  assert.equal(parseInvoiceLinkRef(`1028-${TOKEN.toUpperCase()}`), null);
  assert.equal(parseInvoiceLinkRef(""), null);
});

test("invoice link token validates only against its own hash", () => {
  const hash = hashInvoiceLinkToken(TOKEN);
  assert.equal(isValidInvoiceLinkToken(hash, TOKEN), true);
  assert.equal(isValidInvoiceLinkToken(hash, "b".repeat(64)), false);
  assert.equal(isValidInvoiceLinkToken(null, TOKEN), false);
  assert.equal(isValidInvoiceLinkToken("", TOKEN), false);
});

test("template body maps name, order number and amount to configured keys", () => {
  const order = { id: 1028, customer_name: " Ravi ", order_number: "TAQ-001028", final_total: "4999.00" };
  assert.deepEqual(buildInvoiceTemplateBody(order, ["var_1", "var_2", "var_3"]), {
    var_1: "Ravi",
    var_2: "TAQ-001028",
    var_3: "4999",
  });
  assert.deepEqual(buildInvoiceTemplateBody({ id: 5, total_amount: 1799.5 }, ["name", "order"]), {
    name: "Customer",
    order: "5",
  });
  assert.equal(formatInvoiceAmount("abc"), "");
});

test("MyOperator payload follows /chat/messages template format", () => {
  const payload = buildTemplatePayload({
    phoneNumberId: "PNID",
    countryCode: "+91",
    phoneNumber: "9876543210",
    templateName: "invoice_link",
    language: "en",
    body: { var_1: "Ravi" },
    buttons: [{ index: 0, var1: `1028-${TOKEN}` }],
    refId: "invoice:1028",
  });
  assert.deepEqual(payload, {
    phone_number_id: "PNID",
    customer_country_code: "91",
    customer_number: "9876543210",
    reply_to: null,
    myop_ref_id: "invoice:1028",
    data: {
      type: "template",
      context: {
        template_name: "invoice_link",
        language: "en",
        body: { var_1: "Ravi" },
        buttons: [{ index: 0, var1: `1028-${TOKEN}` }],
      },
    },
  });
});
