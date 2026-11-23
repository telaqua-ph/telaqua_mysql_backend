/**
 * services/leadConfirmation.js
 *
 * "Confirm" on the admin Leads page: the customer paid the COD partial payment
 * (₹199 per unit, max ₹597) manually by scanning the company QR code, and staff
 * enter the UPI transaction ID / UTR. The lead then becomes a normal COD order:
 *
 *   payment_mode = cod, payment_status = Pending (balance collected on delivery)
 *   cod_advance_fee = partial payment, cod_advance_status = paid
 *   cod_advance_razorpay_payment_id = the reference staff entered
 *   cod_amount_due = order total − partial payment
 *
 * Two kinds of lead:
 *  - COD lead (LEAD-xxxx): a cod_advance_payments checkout with no order yet →
 *    a new order is created exactly like a Razorpay-verified COD checkout
 *    (same pricing, stock deduction, WhatsApp, invoice/fulfilment triggers).
 *  - Online lead (TAQ-xxxx): an existing Razorpay order still Pending/Failed →
 *    it is switched to COD with the partial payment recorded and stock deducted.
 *
 * A reference number can only be used once across all orders.
 */
import { pool } from "../config/db.js";
import { buildFinancialSnapshot, resolveOrderPricing } from "./orderPricing.js";
import { assertStockAvailable, deductStockForSale, dispatchInventoryAlertEmails } from "./inventoryService.js";
import { logPaymentEvent, triggerOrderFulfillmentAsync } from "./confirmRazorpayPayment.js";
import { triggerOrderPlacedWhatsAppAsync } from "./interaktOrderPlacedService.js";
import { triggerCalibrationVideoWhatsAppAsync } from "./interaktCalibrationVideoService.js";
import { scheduleMetaPurchase } from "./metaPurchase.js";
import { codPartialAmount } from "../lib/codPartialPayment.js";
import { insertCodAdvanceOrder } from "./codAdvanceService.js";
import { resolveOrderEmail } from "../utils/guestEmail.js";

const REFERENCE = /^[A-Za-z0-9@._\-/]{4,64}$/;
export const MANUAL_PAYMENT_METHODS = ["upi", "bank_transfer", "other"];

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function leadError(message, httpStatus = 409) {
  return Object.assign(new Error(message), { httpStatus, publicMessage: message });
}

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

/** Clean and validate the transaction ID / UTR / UPI reference typed by staff. */
export function normalizePaymentReference(value) {
  const clean = String(value ?? "").replace(/\s+/g, "").trim();
  if (!REFERENCE.test(clean)) {
    throw leadError("Enter the UPI transaction ID / UTR (letters, digits, @ . - _ only, 4–64 characters).", 422);
  }
  return clean;
}

export function normalizeManualMethod(value) {
  const method = String(value ?? "upi").trim().toLowerCase();
  return MANUAL_PAYMENT_METHODS.includes(method) ? method : "upi";
}

/** Partial payment and balance for an order total and quantity. */
export function manualAdvanceSplit(orderTotal, quantity = 1) {
  const total = round2(orderTotal);
  const advance = codPartialAmount(total, quantity);
  return { total, advance, due: round2(total - advance) };
}

const ONLINE_COD = (o) => {
  const mode = String(o?.payment_mode ?? "").trim().toLowerCase();
  const method = String(o?.payment_method ?? "").trim().toLowerCase();
  return mode === "cod" || (mode !== "razorpay" && ["cod", "cash on delivery", "cash_on_delivery"].includes(method));
};

/** True when an order row is still an unpaid online lead (not COD, payment Pending/Failed). */
export function isUnpaidOnlineLead(order) {
  if (!order || ONLINE_COD(order)) return false;
  return ["pending", "failed"].includes(String(order.payment_status ?? "").trim().toLowerCase());
}

async function assertReferenceUnused(db, reference) {
  const used = await db.query(
    `SELECT order_number FROM orders WHERE cod_advance_razorpay_payment_id = ? OR razorpay_payment_id = ? LIMIT 1`,
    [reference, reference]
  );
  if (used.rows[0]) throw leadError(`Reference ${reference} is already recorded on order ${used.rows[0].order_number}. Check the transaction ID.`);
  const attempt = await db.query(`SELECT id FROM cod_advance_payments WHERE razorpay_payment_id = ? LIMIT 1`, [reference]);
  if (attempt.rows[0]) throw leadError(`Reference ${reference} is already recorded on another checkout. Check the transaction ID.`);
}

async function writeCodAudit(db, orderId, actorId, method) {
  await db.query(
    "INSERT INTO cod_payment_audit_log (order_id, admin_id, action) VALUES (?, ?, ?)",
    [orderId, actorId || null, `manual_qr_advance_${method}`.slice(0, 64)]
  ).catch((error) => console.warn("Lead confirm audit failed", { message: error?.message }));
}

function afterOrderConfirmed({ orderId, orderNumber, customerName, phone, total, whatsappConsent, notify }) {
  triggerOrderFulfillmentAsync(orderId);
  if (!notify) return;
  triggerOrderPlacedWhatsAppAsync({ orderDbId: orderId, customerName, customerPhone: phone, orderId: orderNumber, orderAmount: total });
  triggerCalibrationVideoWhatsAppAsync({ orderDbId: orderId, customerName, customerPhone: phone, orderId: orderNumber, whatsappConsent });
  scheduleMetaPurchase({ id: orderId });
}

export const LEAD_SOURCES = ["cod_advance", "checkout_lead"];

const clean = (value) => (value === undefined || value === null ? "" : String(value).trim());

/**
 * Turn saved checkout details into the same shape a website COD order uses.
 * Checkout leads only store what the visitor typed, so fields such as the WhatsApp
 * consent time can be missing; the database driver rejects missing (undefined) values.
 * Returns { orderData, missing } — missing lists the details staff still need.
 */
export function normalizeLeadOrderData(raw = {}) {
  const phone = clean(raw.phone).replace(/\D/g, "").slice(-10);
  const pincode = clean(raw.pincode).replace(/\D/g, "");
  const parts = [clean(raw.address), clean(raw.house_landmark), clean(raw.village), clean(raw.mandal_area)].filter(Boolean);
  const address = parts.filter((part, index) => !parts.slice(0, index).some((prev) => prev.toLowerCase().includes(part.toLowerCase()))).join(", ");
  const consent = raw.whatsapp_updates_consent === true || raw.whatsapp_updates_consent === 1 || raw.whatsapp_updates_consent === "1" || raw.whatsapp_updates_consent === "true";
  const orderData = {
    ...raw,
    customer_name: clean(raw.customer_name),
    phone,
    email: resolveOrderEmail(clean(raw.email), phone),
    address,
    city: clean(raw.city),
    state: clean(raw.state),
    pincode,
    quantity: Math.max(1, Math.floor(Number(raw.quantity) || 1)),
    promo_code: clean(raw.promo_code) || null,
    whatsapp_updates_consent: consent,
    whatsapp_consent_at: consent && raw.whatsapp_consent_at ? raw.whatsapp_consent_at : null,
  };
  for (const key of Object.keys(orderData)) {
    if (orderData[key] === undefined) orderData[key] = null;
  }
  const missing = [];
  if (!orderData.customer_name) missing.push("name");
  if (!/^\d{10}$/.test(orderData.phone)) missing.push("10-digit phone");
  if (!orderData.address) missing.push("address");
  if (!orderData.city) missing.push("city");
  if (!orderData.state) missing.push("state");
  if (!/^\d{6}$/.test(orderData.pincode)) missing.push("6-digit pincode");
  return { orderData, missing };
}

/** Load and lock the checkout row for a COD lead. Returns the customer's checkout details. */
async function lockCheckoutLead(client, source, id) {
  if (source === "checkout_lead") {
    const row = (await client.query("SELECT * FROM checkout_leads WHERE id = ? FOR UPDATE", [id])).rows[0];
    if (!row) throw leadError("Lead not found.", 404);
    if (String(row.lead_status || "").toLowerCase() === "converted" || row.converted_order_id) {
      throw leadError("This lead has already been confirmed as an order.");
    }
    const data = parsePayload(row.payload);
    const orderData = {
      ...data,
      customer_name: data.customer_name || row.customer_name,
      phone: data.phone || row.phone,
      email: data.email || row.email,
      address: data.address || row.address,
      city: data.city || row.city,
      state: data.state || row.state,
      pincode: data.pincode || row.pincode,
      quantity: Number(data.quantity || row.quantity) || 1,
      promo_code: data.promo_code || row.promo_code || null,
    };
    return { row, orderData, quotedAmount: Number(row.final_amount) || 0, invoiceHash: null, declarationAt: null };
  }
  const row = (await client.query("SELECT * FROM cod_advance_payments WHERE id = ? FOR UPDATE", [id])).rows[0];
  if (!row) throw leadError("Lead not found.", 404);
  if (row.order_id) throw leadError("This lead has already been confirmed as an order.");
  if (!["created", "failed"].includes(String(row.status || "").toLowerCase())) {
    throw leadError(`This lead cannot be confirmed (status: ${row.status}).`);
  }
  const payload = parsePayload(row.checkout_payload);
  const orderData = { ...(payload.orderData || {}) };
  orderData.quantity = Number(orderData.quantity) || 1;
  return { row, orderData, quotedAmount: Number(row.product_amount) || 0, invoiceHash: payload.invoice_access_token_hash || null, declarationAt: row.declaration_accepted_at };
}

/**
 * COD lead (checkout_leads or cod_advance_payments row, no order yet) → new COD order with the manual partial payment.
 */
export async function confirmCodLead(attemptId, { source = "cod_advance", reference, method, actorId = null, notify = true } = {}, { db = pool, after = afterOrderConfirmed } = {}) {
  const id = Number(attemptId);
  if (!Number.isInteger(id) || id <= 0) throw leadError("Invalid lead.", 400);
  if (!LEAD_SOURCES.includes(source)) throw leadError("Unknown lead type. Refresh the Leads page.", 400);
  const ref = normalizePaymentReference(reference);
  const payMethod = normalizeManualMethod(method);
  await assertReferenceUnused(db, ref);

  const client = await db.connect();
  let created;
  let orderData;
  let inventoryEmails = [];
  try {
    await client.query("BEGIN");
    const lead = await lockCheckoutLead(client, source, id);
    const normalized = normalizeLeadOrderData(lead.orderData);
    orderData = normalized.orderData;
    if (normalized.missing.length) {
      throw leadError(`This lead is missing the customer's ${normalized.missing.join(", ")}. Use + Add COD Order with the full details instead.`, 422);
    }

    const pricing = await resolveOrderPricing(orderData);
    if (pricing.error) throw leadError(`Could not price this order: ${pricing.error}`, 422);
    const financial = buildFinancialSnapshot(pricing);
    if (lead.quotedAmount > 0 && round2(financial.finalTotal) !== round2(lead.quotedAmount)) {
      throw leadError(`The price changed from ₹${round2(lead.quotedAmount)} to ₹${round2(financial.finalTotal)} since the customer checked out. Use Add COD Order with the agreed price instead.`, 422);
    }
    const split = manualAdvanceSplit(financial.finalTotal, orderData.quantity);
    if (split.advance <= 0) throw leadError("Order total must be positive.", 422);

    const stock = await assertStockAvailable(orderData.quantity);
    if (!stock.ok) throw leadError(stock.message || "Not enough stock for this order.", 409);

    const inserted = await insertCodAdvanceOrder(client, {
      orderData,
      pricing,
      financial,
      attempt: {
        amount_paise: Math.round(split.advance * 100),
        razorpay_order_id: null,
        declaration_accepted_at: lead.declarationAt || new Date(),
      },
      payment: { id: ref },
    });
    const orderId = inserted.insertId;
    const orderNumber = `TAQ-${String(orderId).padStart(6, "0")}`;
    await client.query(
      "UPDATE orders SET order_number = ?, invoice_access_token_hash = ? WHERE id = ?",
      [orderNumber, lead.invoiceHash, orderId]
    );
    if (source === "checkout_lead") {
      await client.query(
        "UPDATE checkout_leads SET lead_status = 'converted', converted_order_id = ? WHERE id = ?",
        [orderId, id]
      );
    } else {
      await client.query(
        `UPDATE cod_advance_payments
           SET status = 'order_created', order_id = ?, amount_paise = ?, razorpay_payment_id = ?,
               failure_reason = NULL, verified_at = COALESCE(verified_at, NOW())
         WHERE id = ?`,
        [orderId, Math.round(split.advance * 100), ref, id]
      );
    }
    const stockResult = await deductStockForSale(client, {
      orderId, orderNumber, quantity: orderData.quantity, isTestOrder: false, reason: "COD order (QR partial payment)",
    });
    if (stockResult.status === "insufficient_stock") throw leadError("Not enough stock to place this order.", 409);
    inventoryEmails = stockResult.pendingEmails || [];
    await client.query("COMMIT");
    created = { orderId, orderNumber, ...split };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error?.code === "ER_DUP_ENTRY") throw leadError(`Reference ${ref} is already recorded. Check the transaction ID.`);
    throw error;
  } finally {
    client.release();
  }

  if (inventoryEmails.length) dispatchInventoryAlertEmails(inventoryEmails);
  await writeCodAudit(db, created.orderId, actorId, payMethod);
  logPaymentEvent("COD_LEAD_CONFIRMED_MANUAL", { leadSource: source, leadId: id, orderId: created.orderId, orderNumber: created.orderNumber, method: payMethod, actorId });
  after({
    orderId: created.orderId,
    orderNumber: created.orderNumber,
    customerName: orderData.customer_name,
    phone: orderData.phone,
    total: created.total,
    whatsappConsent: orderData.whatsapp_updates_consent,
    notify,
  });
  return created;
}

/**
 * Online lead (Razorpay order still Pending/Failed) → the same order switched to COD
 * with the manual partial payment recorded.
 */
export async function confirmOnlineLead(orderId, { reference, method, actorId = null, notify = true } = {}, { db = pool, after = afterOrderConfirmed } = {}) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) throw leadError("Invalid order.", 400);
  const ref = normalizePaymentReference(reference);
  const payMethod = normalizeManualMethod(method);
  await assertReferenceUnused(db, ref);

  const client = await db.connect();
  let order;
  let split;
  let inventoryEmails = [];
  try {
    await client.query("BEGIN");
    order = (await client.query("SELECT * FROM orders WHERE id = ? FOR UPDATE", [id])).rows[0];
    if (!order) throw leadError("Order not found.", 404);
    if (!isUnpaidOnlineLead(order)) throw leadError(`${order.order_number} is not an unpaid online lead any more. Refresh the Leads page.`);

    split = manualAdvanceSplit(Number(order.final_total ?? order.total_amount), order.quantity);
    if (split.advance <= 0) throw leadError("Order total must be positive.", 422);

    await client.query(
      `UPDATE orders
         SET payment_mode = 'cod', payment_method = 'cod', payment_status = 'Pending', order_status = 'Confirmed',
             cod_advance_fee = ?, cod_advance_status = 'paid', cod_advance_razorpay_order_id = NULL,
             cod_advance_razorpay_payment_id = ?, cod_advance_verified_at = NOW(), cod_amount_due = ?,
             cod_fee_declaration_accepted_at = COALESCE(cod_fee_declaration_accepted_at, NOW()),
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [split.advance, ref, split.due, id]
    );
    const stockResult = await deductStockForSale(client, {
      orderId: id, orderNumber: order.order_number, quantity: order.quantity,
      isTestOrder: Boolean(Number(order.is_test_order)), reason: "COD order (QR partial payment)",
    });
    if (stockResult.status === "insufficient_stock") throw leadError("Not enough stock to confirm this order.", 409);
    inventoryEmails = stockResult.pendingEmails || [];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error?.code === "ER_DUP_ENTRY") throw leadError(`Reference ${ref} is already recorded. Check the transaction ID.`);
    throw error;
  } finally {
    client.release();
  }

  if (inventoryEmails.length) dispatchInventoryAlertEmails(inventoryEmails);
  await writeCodAudit(db, id, actorId, payMethod);
  logPaymentEvent("ONLINE_LEAD_CONFIRMED_MANUAL", { orderId: id, orderNumber: order.order_number, method: payMethod, actorId });
  after({
    orderId: id,
    orderNumber: order.order_number,
    customerName: order.customer_name,
    phone: order.phone,
    total: split.total,
    whatsappConsent: Boolean(Number(order.whatsapp_updates_consent)),
    notify,
  });
  return { orderId: id, orderNumber: order.order_number, ...split };
}
