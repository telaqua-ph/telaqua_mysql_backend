/**
 * ₹199 COD partial payment: courier collects only the balance, invoices show
 * "Partially Paid" with the remaining due, and revenue never counts ₹199 twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  codCollectableAmount,
  codPartialRevenueAdjustmentSql,
  isCodPartialPaidOrder,
} from "../lib/codPartialPayment.js";
import { buildShipmentPayload } from "../services/shipmentPayload.js";
import { buildShipwayPayload } from "../services/shipwayPayload.js";
import { codAmountToCollect } from "../services/indiaPostService.js";
import { buildSwipePayload } from "../services/invoiceService.js";
import { generateLocalInvoicePdf } from "../services/localInvoicePdfService.js";

Object.assign(process.env, {
  SHIPWAY_EMAIL: process.env.SHIPWAY_EMAIL || "merchant@example.test",
  SHIPWAY_LICENSE_KEY: process.env.SHIPWAY_LICENSE_KEY || "test-license",
  SHIPWAY_WAREHOUSE_ID: process.env.SHIPWAY_WAREHOUSE_ID || "109177",
  SHIPWAY_RETURN_WAREHOUSE_ID: process.env.SHIPWAY_RETURN_WAREHOUSE_ID || "109177",
});

// ₹8,997 MRP − ₹4,500 coupon = ₹4,497; ₹199 paid online, ₹4,298 due on delivery.
const partialOrder = {
  id: 77, order_number: "TAQ-000077", customer_name: "Asha Rao", phone: "9876543210",
  email: "asha@example.com", address: "12 Lake Road", city: "Bengaluru", state: "Karnataka",
  pincode: "560001", quantity: 3, unit_price: 1499, total_amount: 4497, final_total: 4497,
  subtotal: 4497, taxable_amount: 3811.02, gst_amount: 685.98, gst_rate: 18, shipping_amount: 0,
  promo_code: "DIWALI50", discount_amount: 4500, original_amount: 8997,
  payment_method: "cod", payment_mode: "cod", payment_status: "Pending", order_status: "Confirmed",
  cod_advance_fee: 199, cod_advance_status: "paid", cod_advance_razorpay_payment_id: "pay_part_1",
  cod_amount_due: 4298, created_at: "2026-11-11T10:00:00Z",
};
// Older ₹99 delivery-fee order: fee on top, full total collected.
const legacyOrder = { ...partialOrder, cod_advance_fee: 99, cod_amount_due: 4497 };
const plainCod = { ...partialOrder, cod_advance_fee: null, cod_advance_status: null, cod_amount_due: null };

const product = { name: "Tel-Aqua pH Meter", weightGm: 300, lengthCm: 10, widthCm: 10, heightCm: 10 };
const warehouse = { name: "WH", address: "A", city: "B", state: "C", pincode: "500001", phone: "9000000000" };

test("partial-paid detection separates ₹199 orders from older ₹99-fee and plain COD orders", () => {
  assert.equal(isCodPartialPaidOrder(partialOrder), true);
  assert.equal(isCodPartialPaidOrder(legacyOrder), false);
  assert.equal(isCodPartialPaidOrder(plainCod), false);
  assert.equal(isCodPartialPaidOrder({ ...partialOrder, cod_advance_status: "created" }), false);
});

test("courier collects only the balance after the ₹199 partial payment", () => {
  assert.equal(codCollectableAmount(partialOrder), 4298);
  assert.equal(codCollectableAmount(legacyOrder), 4497);
  assert.equal(codCollectableAmount(plainCod), 4497);

  const delhivery = buildShipmentPayload(partialOrder, { waybill_number: "123" }, warehouse, product).shipments[0];
  assert.equal(delhivery.payment_mode, "COD");
  assert.equal(delhivery.cod_amount, "4298");
  assert.equal(delhivery.total_amount, 4497, "declared value stays the full order total");

  assert.equal(buildShipwayPayload(partialOrder, product).order_total, "4298");
  assert.equal(buildShipwayPayload(plainCod, product).order_total, "4497");
  assert.equal(codAmountToCollect(partialOrder), 4298);
});

test("Swipe invoice records ₹199 as paid and shows the remaining due", () => {
  const payload = buildSwipePayload(partialOrder);
  assert.deepEqual(payload.payments, [{ amount: 199, method: "upi", notes: "COD partial payment pay_part_1" }]);
  assert.match(payload.reference, /Partially Paid Rs 199, Balance Due Rs 4298/);
  assert.match(payload.notes, /Remaining due Rs 4298/);
  assert.match(payload.notes, /DIWALI50/);

  const paid = buildSwipePayload({ ...partialOrder, payment_status: "Paid" });
  assert.deepEqual(paid.payments.map((p) => [p.amount, p.method]), [[199, "upi"], [4298, "cash"]]);

  assert.equal(buildSwipePayload(plainCod).payments, undefined);
});

test("fallback PDF invoice renders for a partially paid COD order", async () => {
  const pdf = await generateLocalInvoicePdf(partialOrder);
  assert.equal(pdf.contentType, "application/pdf");
  assert.ok(pdf.buffer.length > 1000);
});

test("revenue SQL subtracts the ₹199 only for partial-payment orders", () => {
  const cols = new Set(["final_total", "total_amount", "cod_advance_fee", "cod_advance_status", "cod_amount_due"]);
  const sql = codPartialRevenueAdjustmentSql(cols, "o");
  assert.match(sql, /o\.cod_amount_due < COALESCE\(o\.final_total, o\.total_amount\)/);
  assert.equal(codPartialRevenueAdjustmentSql(new Set(["final_total"])), "0");
});
