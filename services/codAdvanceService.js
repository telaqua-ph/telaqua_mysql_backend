/**
 * ₹99 non-refundable advance delivery fee for website COD orders.
 *
 * Flow: create a cod_advance_payments attempt + a ₹99 Razorpay order →
 * customer pays → verify (browser callback or webhook) → only then create the
 * COD order. The product amount stays payable in cash on delivery.
 *
 * Idempotency: the attempt row is locked FOR UPDATE while the order is created,
 * and order_id / razorpay_payment_id are UNIQUE, so repeated callbacks, refreshes
 * and the webhook all resolve to the same single order.
 */

import { pool } from "../config/db.js";
import { getRazorpayClient } from "../config/razorpay.js";
import {
  attributionValues,
  isMissingAttributionColumnError,
} from "../lib/orderAttribution.js";
import { buildFinancialSnapshot, resolveOrderPricing } from "./orderPricing.js";
import { assertStockAvailable } from "./inventoryService.js";
import { logPaymentEvent, triggerOrderFulfillmentAsync } from "./confirmRazorpayPayment.js";
import { triggerOrderPlacedWhatsAppAsync } from "./interaktOrderPlacedService.js";
import { scheduleMetaPurchase } from "./metaPurchase.js";

export const COD_ADVANCE_FEE_RUPEES = 99;
export const COD_ADVANCE_FEE_PAISE = 9900;
export const COD_ADVANCE_PURPOSE = "cod_advance_fee";
export const COD_ADVANCE_DESCRIPTION = "Tel-Aqua COD Advance Delivery Charge";

// pool.query (not the bare query export) so tests can substitute the database.
const query = (sql, params) => pool.query(sql, params);

let razorpayClientFactory = getRazorpayClient;
/** Test seam: replace the Razorpay client. Pass nothing to restore the real one. */
export function setCodAdvanceRazorpayClientForTests(factory) {
  razorpayClientFactory = factory || getRazorpayClient;
}

/** COD without the advance fee stays available only when explicitly disabled. */
export function isCodAdvanceFeeRequired() {
  return String(process.env.COD_ADVANCE_FEE_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** Amounts shown to the customer and stored on the order. */
export function codAdvanceBreakdown(productAmount) {
  const product = round2(productAmount);
  return {
    product_amount: product,
    advance_fee: COD_ADVANCE_FEE_RUPEES,
    pay_now: COD_ADVANCE_FEE_RUPEES,
    pay_on_delivery: product,
    total_order_value: round2(product + COD_ADVANCE_FEE_RUPEES),
  };
}

function parsePayload(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return {};
  }
}

/**
 * Validates a captured ₹99 payment against Razorpay itself (never the browser).
 * @returns {{ ok: true, payment: object } | { ok: false, reason: string, failed?: boolean }}
 */
export function checkCodAdvancePayment({ rzOrder, rzPayment, razorpayOrderId, expectedPaise = COD_ADVANCE_FEE_PAISE }) {
  if (!rzOrder || !rzPayment) return { ok: false, reason: "Payment details are unavailable" };
  if (Number(rzOrder.amount) !== expectedPaise) return { ok: false, reason: "Razorpay order amount is not ₹99" };
  if (Number(rzPayment.amount) !== expectedPaise) return { ok: false, reason: "Payment amount is not ₹99" };
  if (String(rzPayment.currency || "INR").toUpperCase() !== "INR") return { ok: false, reason: "Payment currency is not INR" };
  if (rzPayment.order_id !== razorpayOrderId) return { ok: false, reason: "Payment does not belong to this Razorpay order" };
  const status = String(rzPayment.status || "").toLowerCase();
  if (status === "failed") return { ok: false, reason: "Payment failed", failed: true };
  if (status !== "captured") return { ok: false, reason: "Payment has not been captured yet" };
  return { ok: true, payment: rzPayment };
}

/**
 * Starts a COD checkout: records the attempt and creates a ₹99 Razorpay order.
 * No order row exists until the payment is verified.
 */
export async function createCodAdvanceCheckout({ orderData, productAmount, invoiceAccessHash }) {
  const inserted = await query(
    `INSERT INTO cod_advance_payments
       (amount_paise, status, checkout_payload, product_amount, declaration_accepted_at)
     VALUES (?, 'created', ?, ?, NOW())`,
    [
      COD_ADVANCE_FEE_PAISE,
      JSON.stringify({ orderData, invoice_access_token_hash: invoiceAccessHash }),
      round2(productAmount),
    ]
  );
  const attemptId = inserted.insertId;

  const razorpayOrder = await razorpayClientFactory().orders.create({
    amount: COD_ADVANCE_FEE_PAISE,
    currency: "INR",
    receipt: `codadv_${attemptId}_${Date.now().toString(36)}`.slice(0, 40),
    notes: {
      purpose: COD_ADVANCE_PURPOSE,
      cod_advance_id: String(attemptId),
      description: COD_ADVANCE_DESCRIPTION,
      product_amount: String(round2(productAmount)),
    },
  });

  await query(
    `UPDATE cod_advance_payments SET razorpay_order_id = ? WHERE id = ?`,
    [razorpayOrder.id, attemptId]
  );

  logPaymentEvent("COD_ADVANCE_CREATED", {
    codAdvanceId: attemptId,
    razorpayOrderId: razorpayOrder.id,
    amountPaise: razorpayOrder.amount,
  });

  return { attemptId, razorpayOrder };
}

export async function findCodAdvanceByRazorpayOrderId(razorpayOrderId) {
  const { rows } = await query(
    `SELECT * FROM cod_advance_payments WHERE razorpay_order_id = ? LIMIT 1`,
    [razorpayOrderId]
  );
  return rows[0] || null;
}

async function loadOrder(orderId) {
  const { rows } = await query(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  return rows[0] || null;
}

async function fetchRazorpayState(razorpayOrderId, razorpayPaymentId) {
  const razorpay = razorpayClientFactory();
  const rzOrder = await razorpay.orders.fetch(razorpayOrderId);
  let rzPayment = null;
  if (razorpayPaymentId) {
    rzPayment = await razorpay.payments.fetch(razorpayPaymentId);
  } else {
    const listed = await razorpay.orders.fetchPayments(razorpayOrderId);
    const items = Array.isArray(listed?.items) ? listed.items : [];
    rzPayment = items.find((p) => String(p.status || "").toLowerCase() === "captured") || items[0] || null;
  }
  return { rzOrder, rzPayment };
}

async function insertCodAdvanceOrder(client, { orderData, pricing, financial, attempt, payment }) {
  const core = [
    orderData.customer_name,
    orderData.phone,
    orderData.email,
    orderData.address,
    orderData.city,
    orderData.state,
    orderData.pincode,
    orderData.quantity,
    pricing.unit_price,
    financial.finalTotal,
    pricing.promo_code,
    pricing.original_amount,
    pricing.discount_amount,
    financial.subtotal,
    financial.taxableAmount,
    financial.gstAmount,
    financial.gstRate,
    financial.shippingAmount,
    financial.finalTotal,
    orderData.whatsapp_updates_consent ? 1 : 0,
    orderData.whatsapp_consent_at,
    COD_ADVANCE_FEE_RUPEES,
    attempt.razorpay_order_id,
    payment.id,
    financial.finalTotal,
    attempt.declaration_accepted_at,
  ];
  const columns = `customer_name, phone, email, address, city, state, pincode, quantity,
    unit_price, total_amount, payment_method, payment_status, order_status, payment_mode,
    promo_code, original_amount, discount_amount, subtotal, taxable_amount, gst_amount,
    gst_rate, shipping_amount, final_total, invoice_status, whatsapp_updates_consent,
    whatsapp_consent_at, cod_advance_fee, cod_advance_status, cod_advance_razorpay_order_id,
    cod_advance_razorpay_payment_id, cod_advance_verified_at, cod_amount_due,
    cod_fee_declaration_accepted_at`;
  const values = `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cod', 'Pending', 'Confirmed', 'cod',
    ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_created', ?, ?, ?, 'paid', ?, ?, NOW(), ?, ?`;

  try {
    return await client.query(
      `INSERT INTO orders (${columns}, utm_source, utm_medium, utm_campaign, utm_term,
         utm_content, gclid, fbclid, fbp, fbc, landing_url, first_seen_at)
       VALUES (${values}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...core, ...attributionValues(orderData)]
    );
  } catch (error) {
    if (!isMissingAttributionColumnError(error)) throw error;
    return client.query(`INSERT INTO orders (${columns}) VALUES (${values})`, core);
  }
}

/**
 * Verifies the ₹99 payment with Razorpay and creates the COD order exactly once.
 * Safe to call repeatedly (browser verify, refresh, webhook, admin retry).
 *
 * @returns {Promise<{status: "created"|"already_created"|"not_found"|"payment_invalid"|"order_failed", order?: object, reason?: string}>}
 */
export async function finalizeCodAdvancePayment({ razorpayOrderId, razorpayPaymentId = null, source = "verify" }) {
  const attempt = await findCodAdvanceByRazorpayOrderId(razorpayOrderId);
  if (!attempt) return { status: "not_found" };
  if (attempt.order_id) return { status: "already_created", order: await loadOrder(attempt.order_id) };

  let state;
  try {
    state = await fetchRazorpayState(razorpayOrderId, razorpayPaymentId);
  } catch (error) {
    console.error("COD advance Razorpay fetch failed:", error?.error?.description || error?.message);
    return { status: "payment_invalid", reason: "Could not confirm the payment with Razorpay" };
  }
  const check = checkCodAdvancePayment({
    ...state,
    razorpayOrderId,
    expectedPaise: Number(attempt.amount_paise),
  });
  if (!check.ok) {
    if (check.failed) await markCodAdvanceFailed(razorpayOrderId, check.reason);
    logPaymentEvent("COD_ADVANCE_REJECTED", { razorpayOrderId, reason: check.reason, source });
    return { status: "payment_invalid", reason: check.reason };
  }
  const payment = check.payment;

  const client = await pool.connect();
  let created = null;
  let orderData = null;
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT * FROM cod_advance_payments WHERE id = ? FOR UPDATE`,
      [attempt.id]
    );
    const current = locked.rows[0];
    if (current.order_id) {
      await client.query("COMMIT");
      return { status: "already_created", order: await loadOrder(current.order_id) };
    }

    const payload = parsePayload(current.checkout_payload);
    orderData = payload.orderData || {};

    // Re-price and re-check stock at order time; never trust the earlier quote blindly.
    const pricing = await resolveOrderPricing(orderData);
    let failure = pricing.error || null;
    let financial = null;
    if (!failure) {
      financial = buildFinancialSnapshot(pricing);
      if (round2(financial.finalTotal) !== round2(current.product_amount)) {
        failure = `Product price changed from ₹${current.product_amount} to ₹${financial.finalTotal}`;
      }
    }
    if (!failure) {
      const stock = await assertStockAvailable(orderData.quantity);
      if (!stock.ok) failure = stock.message || "Insufficient stock";
    }

    if (failure) {
      // Payment is kept on record for recovery (retry or refund) — never silently dropped.
      await client.query(
        `UPDATE cod_advance_payments
         SET status = 'paid_order_failed', razorpay_payment_id = ?, failure_reason = ?,
             verified_at = COALESCE(verified_at, NOW())
         WHERE id = ?`,
        [payment.id, String(failure).slice(0, 500), current.id]
      );
      await client.query("COMMIT");
      logPaymentEvent("COD_ADVANCE_ORDER_FAILED", { codAdvanceId: current.id, razorpayOrderId, reason: failure, source });
      return { status: "order_failed", reason: failure };
    }

    const inserted = await insertCodAdvanceOrder(client, {
      orderData,
      pricing,
      financial,
      attempt: current,
      payment,
    });
    const orderId = inserted.insertId;
    const orderNumber = `TAQ-${String(orderId).padStart(6, "0")}`;
    await client.query(
      `UPDATE orders SET order_number = ?, invoice_access_token_hash = ? WHERE id = ?`,
      [orderNumber, payload.invoice_access_token_hash || null, orderId]
    );
    await client.query(
      `UPDATE cod_advance_payments
       SET status = 'order_created', order_id = ?, razorpay_payment_id = ?,
           failure_reason = NULL, verified_at = COALESCE(verified_at, NOW())
       WHERE id = ?`,
      [orderId, payment.id, current.id]
    );
    await client.query("COMMIT");
    created = { id: orderId, orderNumber, finalTotal: financial.finalTotal };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  logPaymentEvent("COD_ADVANCE_ORDER_CREATED", {
    orderId: created.id,
    orderNumber: created.orderNumber,
    razorpayOrderId,
    razorpayPaymentId: payment.id,
    source,
  });

  // Notifications only after the payment is verified and the order is committed.
  triggerOrderFulfillmentAsync(created.id);
  triggerOrderPlacedWhatsAppAsync({
    orderDbId: created.id,
    customerName: orderData.customer_name,
    customerPhone: orderData.phone,
    orderId: created.orderNumber,
    orderAmount: created.finalTotal,
  });
  scheduleMetaPurchase({ id: created.id });

  return { status: "created", order: await loadOrder(created.id) };
}

/** Marks an unpaid attempt failed (payment.failed webhook). Paid attempts are never downgraded. */
export async function markCodAdvanceFailed(razorpayOrderId, reason = "Payment failed") {
  const result = await query(
    `UPDATE cod_advance_payments
     SET status = 'failed', failure_reason = ?
     WHERE razorpay_order_id = ? AND status = 'created'`,
    [String(reason).slice(0, 500), razorpayOrderId]
  );
  return result.rowCount ?? result.affectedRows ?? 0;
}

/** Paid ₹99 advances with no order yet — need a retry or a refund. */
export async function listCodAdvanceIssues() {
  const { rows } = await query(
    `SELECT id, razorpay_order_id, razorpay_payment_id, amount_paise, status, product_amount,
            failure_reason, declaration_accepted_at, verified_at, created_at, updated_at,
            JSON_UNQUOTE(JSON_EXTRACT(checkout_payload, '$.orderData.customer_name')) AS customer_name,
            JSON_UNQUOTE(JSON_EXTRACT(checkout_payload, '$.orderData.phone')) AS phone
     FROM cod_advance_payments
     WHERE status = 'paid_order_failed'
     ORDER BY created_at DESC
     LIMIT 200`
  );
  return rows;
}

/** Records that an admin refunded the ₹99 in Razorpay for an advance that never became an order. */
export async function markCodAdvanceRefunded(attemptId, note) {
  const result = await query(
    `UPDATE cod_advance_payments
     SET status = 'refunded', failure_reason = ?
     WHERE id = ? AND status = 'paid_order_failed' AND order_id IS NULL`,
    [String(note || "Refunded by admin").slice(0, 500), attemptId]
  );
  return (result.rowCount ?? result.affectedRows ?? 0) > 0;
}

/**
 * COD checkouts where the customer filled in the address but never paid the ₹99
 * (closed the Razorpay window or the payment failed). No order row exists for
 * these. Shown read-only in the admin Orders list so the team can follow up.
 *
 * - One row per phone number (the latest attempt).
 * - Skipped once that phone has placed any order after the attempt.
 */
export async function listUnpaidCodCheckouts({ limit = 500 } = {}) {
  const { rows } = await query(
    `SELECT cap.id, cap.status, cap.product_amount, cap.failure_reason,
            cap.razorpay_order_id, cap.created_at, cap.updated_at,
            JSON_UNQUOTE(JSON_EXTRACT(cap.checkout_payload, '$.orderData.customer_name')) AS customer_name,
            JSON_UNQUOTE(JSON_EXTRACT(cap.checkout_payload, '$.orderData.phone')) AS phone,
            JSON_UNQUOTE(JSON_EXTRACT(cap.checkout_payload, '$.orderData.email')) AS email,
            JSON_UNQUOTE(JSON_EXTRACT(cap.checkout_payload, '$.orderData.address')) AS address,
            JSON_UNQUOTE(JSON_EXTRACT(cap.checkout_payload, '$.orderData.city')) AS city,
            JSON_UNQUOTE(JSON_EXTRACT(cap.checkout_payload, '$.orderData.state')) AS state,
            JSON_UNQUOTE(JSON_EXTRACT(cap.checkout_payload, '$.orderData.pincode')) AS pincode,
            JSON_UNQUOTE(JSON_EXTRACT(cap.checkout_payload, '$.orderData.quantity')) AS quantity,
            JSON_UNQUOTE(JSON_EXTRACT(cap.checkout_payload, '$.orderData.promo_code')) AS promo_code
     FROM cod_advance_payments cap
     WHERE cap.order_id IS NULL
       AND cap.status IN ('created', 'failed')
       AND NOT EXISTS (
         SELECT 1 FROM orders o
         WHERE o.phone = JSON_UNQUOTE(JSON_EXTRACT(cap.checkout_payload, '$.orderData.phone'))
           AND o.created_at >= cap.created_at
       )
     ORDER BY cap.created_at DESC, cap.id DESC
     LIMIT ?`,
    [Number(limit) || 500]
  );

  const seenPhones = new Set();
  const latest = [];
  for (const row of rows) {
    const clean = (value) => (value == null || value === "null" ? "" : String(value));
    const phone = clean(row.phone);
    const key = phone || `attempt-${row.id}`;
    if (seenPhones.has(key)) continue;
    seenPhones.add(key);
    latest.push({
      ...row,
      customer_name: clean(row.customer_name),
      phone,
      email: clean(row.email),
      address: clean(row.address),
      city: clean(row.city),
      state: clean(row.state),
      pincode: clean(row.pincode),
      promo_code: clean(row.promo_code),
      quantity: Number(row.quantity) || 1,
      product_amount: Number(row.product_amount) || 0,
    });
  }
  return latest;
}
