import test from "node:test";
import assert from "node:assert/strict";
import { buildSwipePayload, canGenerateOrderInvoice } from "../services/invoiceService.js";
import {
  createSwipeInvoiceForOrder,
  getSwipeInvoicePdf,
} from "../services/swipeService.js";
import { generateLocalInvoicePdf } from "../services/localInvoicePdfService.js";

function order(overrides = {}) {
  return {
    id: 1058,
    order_number: "TAQ-001058",
    customer_name: "Test Customer",
    phone: "9876543210",
    email: "test@example.com",
    address: "1 Test Road",
    city: "Hyderabad",
    state: "Telangana",
    pincode: "500001",
    quantity: 1,
    total_amount: 2124,
    final_total: 2124,
    subtotal: 2000,
    discount_amount: 200,
    taxable_amount: 1800,
    gst_amount: 324,
    gst_rate: 18,
    shipping_amount: 0,
    promo_code: "WELCOME10",
    payment_method: "upi",
    payment_date: new Date("2026-08-12T00:00:00Z"),
    razorpay_payment_id: "pay_test123",
    whatsapp_updates_consent: true,
    is_test_order: false,
    ...overrides,
  };
}

test("discounted taxable value, GST, Razorpay payment and Swipe total match", () => {
  const payload = buildSwipePayload(order());
  assert.equal(payload.items[0].net_amount, 1800);
  assert.equal(payload.items[0].total_amount, 2124);
  assert.equal(payload.items[0].tax_rate, 18);
  assert.equal(payload.items[0].hsn_code, "90314900");
  assert.equal(payload.payments[0].amount, 2124);
  assert.match(payload.reference, /TAQ-001058/);
  assert.match(payload.reference, /pay_test123/);
});

test("multiple quantities use the stored order snapshot", () => {
  const payload = buildSwipePayload(order({
    quantity: 3,
    taxable_amount: 5400,
    gst_amount: 972,
    final_total: 6372,
    total_amount: 6372,
  }));
  assert.equal(payload.items[0].quantity, 3);
  assert.equal(payload.items[0].unit_price, 1800);
  assert.equal(payload.items[0].price_with_tax, 2124);
  assert.equal(payload.payments[0].amount, 6372);
});

test("shipping is included once and preserves the final total", () => {
  const payload = buildSwipePayload(order({
    shipping_amount: 100,
    final_total: 2224,
    total_amount: 2224,
  }));
  assert.equal(payload.items.length, 2);
  assert.equal(payload.items[1].name, "Shipping");
  assert.equal(payload.items[1].total_amount, 100);
  assert.equal(payload.items.reduce((sum, item) => sum + item.total_amount, 0), 2224);
  assert.equal(payload.payments[0].amount, 2224);
});

test("an inconsistent snapshot is rejected before calling Swipe", () => {
  assert.throws(
    () => buildSwipePayload(order({ final_total: 9999 })),
    /financial snapshot is inconsistent/
  );
});

test("Rs 1 test invoice keeps enough precision for Swipe tax validation", () => {
  const payload = buildSwipePayload(order({
    id: 129,
    order_number: "TEST-000129",
    is_test_order: true,
    subtotal: 1,
    taxable_amount: 0.85,
    gst_amount: 0.15,
    final_total: 1,
    total_amount: 1,
  }));
  assert.equal(payload.items[0].unit_price, 0.847458);
  assert.equal(payload.items[0].price_with_tax, 1);
  assert.equal(payload.items[0].total_amount, 1);
  assert.equal(payload.payments[0].amount, 1);
  assert.equal(payload.items[0].unit, "UNT");
  assert.equal(payload.items[0].hsn_code, "90314900");
  assert.equal(payload.party.billing_address, undefined);
});

test("Swipe mapping and missing-bank responses are corrected before one invoice succeeds", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.SWIPE_API_KEY;
  const requests = [];
  const replies = [
    { status: 400, body: { success: false, message: "customer is already mapped with id TAQ-ORDER-129" } },
    { status: 400, body: { success: false, message: "These product names are already mapped: Test Product → TAQ-PRODUCT-ORDER-129" } },
    { status: 400, body: { success: false, message: "Bank details not found" } },
    { status: 200, body: { success: true, data: { hash_id: "hash-1", serial_number: "BM-29" } } },
  ];
  process.env.SWIPE_API_KEY = "test-only-key";
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const reply = replies.shift();
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const testOrder = order({ id: 133, is_test_order: true, total_amount: 1,
      final_total: 1, subtotal: 1, taxable_amount: 0.85, gst_amount: 0.15 });
    const result = await createSwipeInvoiceForOrder(
      testOrder,
      buildSwipePayload(testOrder)
    );
    assert.equal(result.data.hash_id, "hash-1");
    assert.equal(requests.length, 4);
    assert.equal(requests[1].party.id, "TAQ-ORDER-129");
    assert.equal(requests[2].items[0].id, "TAQ-PRODUCT-ORDER-129");
    assert.equal(requests[3].payments, undefined);
    assert.match(requests[3].notes, /Paid via Razorpay/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SWIPE_API_KEY;
    else process.env.SWIPE_API_KEY = originalKey;
  }
});

test("Swipe HTTP 200 JSON errors are never returned as PDF files", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.SWIPE_API_KEY;
  process.env.SWIPE_API_KEY = "test-only-key";
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: false,
    message: "You have reached your monthly API usage limit.",
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  try {
    await assert.rejects(
      () => getSwipeInvoicePdf("hash-1"),
      (error) => error.statusCode === 502 && /monthly API usage limit/.test(error.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SWIPE_API_KEY;
    else process.env.SWIPE_API_KEY = originalKey;
  }
});

test("paid-order fallback PDF contains a valid PDF header and HSN", async () => {
  const pdf = await generateLocalInvoicePdf(order());
  assert.equal(pdf.contentType, "application/pdf");
  assert.equal(pdf.buffer.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(pdf.buffer.length > 1000);
  assert.equal(pdf.source, "local_fallback");
});

test("COD Pending and Paid orders may generate an invoice", () => {
  assert.equal(
    canGenerateOrderInvoice({ payment_mode: "cod", payment_status: "Pending" }),
    true
  );
  assert.equal(
    canGenerateOrderInvoice({ payment_method: "cod", payment_status: "Pending" }),
    true
  );
  assert.equal(
    canGenerateOrderInvoice({ payment_mode: "cod", payment_status: "Paid" }),
    true
  );
});

test("Paid Razorpay may generate an invoice; unpaid Razorpay is blocked", () => {
  assert.equal(
    canGenerateOrderInvoice({ payment_mode: "razorpay", payment_status: "Paid" }),
    true
  );
  assert.equal(
    canGenerateOrderInvoice({ payment_mode: "razorpay", payment_status: "Pending" }),
    false
  );
  assert.equal(
    canGenerateOrderInvoice({ payment_mode: "razorpay", payment_status: "Failed" }),
    false
  );
  assert.equal(
    canGenerateOrderInvoice({ payment_method: "upi", payment_status: "Pending" }),
    false
  );
});

test("payment_mode razorpay wins over a COD payment_method for invoice eligibility", () => {
  assert.equal(
    canGenerateOrderInvoice({
      payment_mode: "razorpay",
      payment_method: "cod",
      payment_status: "Pending",
    }),
    false
  );
});
