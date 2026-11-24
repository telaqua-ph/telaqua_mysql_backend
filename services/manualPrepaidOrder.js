/**
 * services/manualPrepaidOrder.js
 *
 * "+ Add Order" → Prepaid (already paid): staff add an order the customer has
 * ALREADY PAID in full outside the website checkout (UPI / QR, bank transfer,
 * or a Razorpay payment link) and enter the transaction ID / UTR.
 *
 * The order is stored like a paid online order (payment_mode = 'razorpay' — the
 * column only allows 'razorpay' | 'cod' — payment_status = 'Paid'), so the
 * courier ships it as PREPAID (nothing collected on delivery), invoices show it
 * as paid, and the dashboard counts it in paid orders / revenue / devices sold.
 * It is marked separately with manual_payment_* columns so it is never confused
 * with a website Razorpay checkout.
 *
 * Safety:
 *  - a reference can be used only once across all orders and COD advances;
 *  - Razorpay ids (pay_…) are checked with Razorpay: must be captured and for the full amount;
 *  - the amount received must equal the order total.
 */
import { pool } from "../config/db.js";
import { getRazorpayClient } from "../config/razorpay.js";
import { deductStockForSale, dispatchInventoryAlertEmails } from "./inventoryService.js";

export const MANUAL_PREPAID_METHODS = {
  upi: "UPI / QR",
  bank_transfer: "Bank transfer",
  razorpay_link: "Razorpay payment link",
  other: "Other",
};

const REFERENCE = /^[A-Za-z0-9@._\-/]{4,64}$/;
const RAZORPAY_PAYMENT_ID = /^pay_[A-Za-z0-9]{6,40}$/;

function prepaidError(message, httpStatus = 422) {
  return Object.assign(new Error(message), { httpStatus, publicMessage: message });
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** YYYY-MM-DD in India (IST) for a Date. */
export function istDate(date = new Date()) {
  return new Date(date.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Validate the payment part of the form.
 * @returns {{ reference, method, methodLabel, paidOn, amountReceived, isRazorpayId }}
 */
export function validatePrepaidPayment(body = {}, { orderTotal, today = istDate() } = {}) {
  const reference = String(body.payment_reference ?? "").replace(/\s+/g, "").trim();
  if (!REFERENCE.test(reference)) {
    throw prepaidError("Enter the transaction ID / UTR / Razorpay payment ID (letters, digits, @ . - _ only, 4–64 characters).");
  }
  const method = String(body.payment_method ?? "").trim().toLowerCase();
  if (!MANUAL_PREPAID_METHODS[method]) throw prepaidError("Choose how the customer paid: UPI / QR, bank transfer, Razorpay payment link or other.");

  const paidOn = String(body.paid_on ?? "").trim() || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(Date.parse(`${paidOn}T00:00:00+05:30`))) {
    throw prepaidError("Payment date must be a valid date.");
  }
  if (paidOn > today) throw prepaidError("Payment date cannot be in the future.");

  const total = round2(orderTotal);
  const amountReceived = body.amount_received === undefined || body.amount_received === null || body.amount_received === ""
    ? total
    : round2(body.amount_received);
  if (!Number.isFinite(amountReceived) || amountReceived <= 0) throw prepaidError("Amount received must be a positive number.");
  if (amountReceived !== total) {
    throw prepaidError(`Amount received (₹${amountReceived}) does not match the order total (₹${total}). A prepaid order must be paid in full — use COD for part payments.`);
  }

  if (body.payment_confirmed !== true && body.payment_confirmed !== "true") {
    throw prepaidError("Tick the box to confirm the payment was received in the company account.");
  }

  return {
    reference,
    method,
    methodLabel: MANUAL_PREPAID_METHODS[method],
    paidOn,
    amountReceived,
    isRazorpayId: RAZORPAY_PAYMENT_ID.test(reference),
  };
}

/** Throws if the reference is already on any order or COD advance. */
export async function assertPrepaidReferenceUnused(reference, { db = pool } = {}) {
  const checks = [
    ["SELECT order_number FROM orders WHERE manual_payment_reference = ? LIMIT 1", "order"],
    ["SELECT order_number FROM orders WHERE razorpay_payment_id = ? LIMIT 1", "order"],
    ["SELECT order_number FROM orders WHERE cod_advance_razorpay_payment_id = ? LIMIT 1", "order"],
    ["SELECT id AS order_number FROM cod_advance_payments WHERE razorpay_payment_id = ? LIMIT 1", "checkout"],
  ];
  for (const [sql, kind] of checks) {
    let rows = [];
    try {
      rows = (await db.query(sql, [reference])).rows || [];
    } catch (error) {
      // A missing manual_payment_reference column just means no manual prepaid orders yet.
      if (!/Unknown column/i.test(String(error?.message || ""))) throw error;
    }
    if (rows[0]) {
      throw prepaidError(
        kind === "order"
          ? `Reference ${reference} is already recorded on order ${rows[0].order_number}. Check the transaction ID.`
          : `Reference ${reference} is already recorded on a website COD checkout. Check the transaction ID.`,
        409
      );
    }
  }
}

/**
 * For Razorpay payment ids: confirm with Razorpay that the payment is captured
 * and for the full order amount. Returns the Razorpay payment method (upi/card/…).
 */
export async function verifyRazorpayPayment(paymentId, amountRupees, { client = null } = {}) {
  let payment;
  try {
    payment = await (client || getRazorpayClient()).payments.fetch(paymentId);
  } catch (error) {
    throw prepaidError(`Could not find payment ${paymentId} in Razorpay. Check the ID, or choose UPI / bank transfer if it was not a Razorpay payment.`);
  }
  const status = String(payment?.status || "").toLowerCase();
  if (status !== "captured") {
    throw prepaidError(`Razorpay payment ${paymentId} is "${status || "unknown"}", not captured. Only captured (successful) payments can confirm an order.`);
  }
  const expected = Math.round(round2(amountRupees) * 100);
  if (Number(payment.amount) !== expected) {
    throw prepaidError(`Razorpay payment ${paymentId} is for ₹${round2(Number(payment.amount) / 100)}, but the order total is ₹${round2(amountRupees)}.`);
  }
  return String(payment.method || "").toLowerCase() || "razorpay";
}

let columnsReady = null;
/** Adds the manual payment columns once (MariaDB: ADD COLUMN IF NOT EXISTS). */
export function ensureManualPrepaidColumns({ db = pool } = {}) {
  if (!columnsReady) {
    columnsReady = (async () => {
      await db.query(`ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS manual_payment_reference VARCHAR(64) NULL,
        ADD COLUMN IF NOT EXISTS manual_payment_method VARCHAR(32) NULL,
        ADD COLUMN IF NOT EXISTS manual_payment_verified_by VARCHAR(16) NULL,
        ADD COLUMN IF NOT EXISTS manual_payment_recorded_by INT NULL`);
      await db.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_manual_payment_ref ON orders (manual_payment_reference)");
    })().catch((error) => {
      columnsReady = null;
      throw error;
    });
  }
  return columnsReady;
}

/** Payment date stored on the order: now for today, otherwise noon IST on the chosen day (as UTC). */
export function paymentDateValue(paidOn, today = istDate()) {
  if (paidOn === today) return null; // null → use NOW() in SQL
  return new Date(`${paidOn}T12:00:00+05:30`).toISOString().slice(0, 19).replace("T", " ");
}

/** Deduct stock for the new order; removes the order again if there is not enough stock. */
export async function deductStockOrRollback(orderId, orderNumber, quantity, { db = pool } = {}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const stock = await deductStockForSale(client, { orderId, orderNumber, quantity, isTestOrder: false, reason: "Prepaid order (manual payment)" });
    if (stock.status === "insufficient_stock") {
      await client.query("ROLLBACK");
      await db.query("DELETE FROM orders WHERE id = ?", [orderId]);
      throw prepaidError("Not enough stock to place this order.", 409);
    }
    await client.query("COMMIT");
    if (stock.pendingEmails?.length) dispatchInventoryAlertEmails(stock.pendingEmails);
    return stock;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
