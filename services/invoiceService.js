/**
 * Idempotent Swipe invoice creation after a Razorpay payment is captured.
 * All money values come from the order snapshot; current product prices are never read.
 */

import crypto from "node:crypto";
import { query } from "../config/db.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";
import { generateLocalInvoicePdf } from "./localInvoicePdfService.js";
import {
  createSwipeInvoiceForOrder,
  getSwipeInvoiceDetails,
  getSwipeInvoicePdf,
  updateSwipeInvoiceForOrder,
} from "./swipeService.js";

const ORDER_SELECT = `
  SELECT
    id, customer_name, phone, email, address, city, state, pincode,
    quantity, unit_price, total_amount, payment_method, payment_status,
    order_status, order_number, razorpay_order_id, razorpay_payment_id,
    payment_date, promo_code, original_amount, discount_amount,
    COALESCE(is_test_order, 0) AS is_test_order,
    subtotal, taxable_amount, gst_amount, gst_rate, shipping_amount,
    final_total, invoice_number, invoice_url, invoice_generated_at,
    invoice_status, invoice_processing_started_at, invoice_attempt_token,
    swipe_invoice_id, swipe_invoice_error, whatsapp_invoice_status,
    whatsapp_invoice_message_id, whatsapp_invoice_sent_at,
    whatsapp_invoice_error, whatsapp_updates_consent, whatsapp_consent_at
  FROM orders WHERE id = ? LIMIT 1
`;

export async function loadOrderForFulfillment(orderId) {
  const { rows } = await query(ORDER_SELECT, [orderId]);
  return rows[0] || null;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function round6(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function formatDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return [
    String(date.getDate()).padStart(2, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    date.getFullYear(),
  ].join("-");
}

function buildAddress(order) {
  return {
    addr_id: 1,
    addr_id_v2: `order-${order.id}-address`,
    address_line1: String(order.address || "").slice(0, 200),
    address_line2: "",
    city: String(order.city || ""),
    state: String(order.state || "").trim().toUpperCase(),
    country: "India",
    pincode: String(order.pincode || ""),
  };
}

function buildParty(order) {
  const phone = normalizeIndianPhone(order.phone);
  // An order-specific party preserves the billing snapshot if a customer later
  // changes their profile. Swipe updates old documents linked to reused party IDs.
  const party = {
    id: `TAQ-ORDER-${order.id}`,
    type: "customer",
    name: String(order.customer_name || `Order ${order.id}`),
    email: order.email || undefined,
  };
  if (!order.is_test_order) {
    party.billing_address = buildAddress(order);
    party.shipping_address = buildAddress(order);
  }
  if (!phone.error) {
    party.country_code = "91";
    party.phone_number = phone.phoneNumber;
  }
  return party;
}

function getFinancialSnapshot(order) {
  const finalTotal = round2(order.final_total ?? order.total_amount);
  const shipping = round2(order.shipping_amount || 0);
  const rate = round2(order.gst_rate ?? 18);
  const taxable = round2(
    order.taxable_amount ?? (finalTotal - shipping) / (1 + rate / 100)
  );
  const gst = round2(order.gst_amount ?? finalTotal - shipping - taxable);
  const productTotal = round2(taxable + gst);

  if (
    !Number.isFinite(finalTotal) ||
    finalTotal <= 0 ||
    round2(productTotal + shipping) !== finalTotal
  ) {
    const error = new Error("Order financial snapshot is inconsistent");
    error.statusCode = 400;
    throw error;
  }
  return { finalTotal, shipping, rate, taxable, gst, productTotal };
}

function mapPaymentMethod(value) {
  const method = String(value || "").trim().toLowerCase();
  return {
    upi: "upi", card: "card", netbanking: "netBanking", emi: "emi",
    cash: "cash", cheque: "cheque", wallet: "upi", paylater: "emi",
    razorpay: "upi",
  }[method] || "upi";
}

export function buildSwipePayload(order) {
  const money = getFinancialSnapshot(order);
  const quantity = Math.max(1, Number(order.quantity) || 1);
  // Swipe validates that unit_price + tax exactly reconciles to price_with_tax.
  // Keep additional precision for the tax-exclusive API value (especially for
  // the Rs 1 test invoice); the document still rounds currency to two decimals.
  const exactTaxable = round6(money.productTotal / (1 + money.rate / 100));
  const productItem = {
    id: `TAQ-PRODUCT-ORDER-${order.id}`,
    name: order.is_test_order
      ? "Tel-Aqua Razorpay Test Product"
      : process.env.TELAQUA_PRODUCT_NAME || "Tel-Aqua PH Meter",
    quantity,
    unit_price: round6(exactTaxable / quantity),
    tax_rate: money.rate,
    price_with_tax: round2(money.productTotal / quantity),
    net_amount: exactTaxable,
    total_amount: money.productTotal,
    item_type: "Product",
    unit: "UNT",
    hsn_code: String(process.env.SWIPE_PRODUCT_HSN || "90314900"),
  };
  const items = [productItem];
  if (money.shipping > 0) {
    items.push({
      id: `TAQ-SHIPPING-ORDER-${order.id}`,
      name: "Shipping",
      quantity: 1,
      unit_price: money.shipping,
      tax_rate: 0,
      price_with_tax: money.shipping,
      net_amount: money.shipping,
      total_amount: money.shipping,
      item_type: "Service",
      unit: "UNT",
    });
  }

  return {
    document_type: "invoice",
    document_date: formatDate(order.payment_date || new Date()),
    party: buildParty(order),
    items,
    payments: [{
      amount: money.finalTotal,
      method: mapPaymentMethod(order.payment_method),
      notes: String(order.razorpay_payment_id || ""),
    }],
    reference: `Website Order: ${order.order_number || order.id}; Razorpay Payment: ${order.razorpay_payment_id}`,
    notes: order.promo_code
      ? `Coupon ${order.promo_code}; discount Rs ${round2(order.discount_amount || 0)}`
      : undefined,
    // Swipe uses the order snapshot contact data for dashboard-configured email/
    // WhatsApp automation. send_wtsp is enabled only with explicit site consent.
    send_wtsp: Boolean(order.whatsapp_updates_consent && !order.is_test_order),
    send_sms: false,
  };
}

function existingInvoice(order) {
  return {
    invoice_number: order.invoice_number || null,
    invoice_url: order.invoice_url || null,
    invoice_generated_at: order.invoice_generated_at || null,
    swipe_invoice_id: order.swipe_invoice_id || null,
    created: false,
    pending: false,
  };
}

async function claimInvoiceCreation(orderId) {
  const token = crypto.randomUUID();
  const { rowCount } = await query(
    `UPDATE orders
     SET invoice_status = 'pending', invoice_attempt_token = ?,
         invoice_processing_started_at = CURRENT_TIMESTAMP,
         swipe_invoice_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND payment_status = 'Paid' AND swipe_invoice_id IS NULL
       AND (
         invoice_status IS NULL
         OR LOWER(invoice_status) IN ('not_created', 'not created', 'failed')
         OR (LOWER(invoice_status) = 'pending' AND (
             invoice_processing_started_at IS NULL
             OR invoice_processing_started_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
         ))
       )`,
    [token, orderId]
  );
  return rowCount ? token : null;
}

export async function ensureSwipeInvoiceForPaidOrder(orderId) {
  console.log(`[Invoice] Starting for order ${orderId}`);
  let order = await loadOrderForFulfillment(orderId);
  if (!order) {
    const error = new Error("Order not found");
    error.statusCode = 404;
    throw error;
  }
  if (String(order.payment_status).trim() !== "Paid") {
    const error = new Error("Order payment is not completed");
    error.statusCode = 400;
    throw error;
  }
  console.log(`[Invoice] Order is PAID: ${order.order_number || order.id}`);
  if (order.swipe_invoice_id) {
    if (String(order.invoice_status || "").toLowerCase() !== "generated") {
      await query(
        `UPDATE orders SET invoice_status = 'generated',
           invoice_generated_at = COALESCE(invoice_generated_at, CURRENT_TIMESTAMP),
           swipe_invoice_error = NULL, invoice_attempt_token = NULL,
           invoice_processing_started_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [order.id]
      );
      order = await loadOrderForFulfillment(order.id);
    }
    return existingInvoice(order);
  }

  const attemptToken = await claimInvoiceCreation(order.id);
  if (!attemptToken) {
    order = await loadOrderForFulfillment(order.id);
    if (order?.swipe_invoice_id) return existingInvoice(order);
    return { ...existingInvoice(order), pending: true };
  }

  console.log(`[Invoice] Calling Swipe for ${order.order_number || order.id}`);
  try {
    const result = await createSwipeInvoiceForOrder(order, buildSwipePayload(order));
    const hashId = String(result?.data?.hash_id || "");
    let serialNumber = result?.data?.serial_number
      ? String(result.data.serial_number)
      : null;
    if (!hashId) throw new Error("Swipe response missing hash_id");
    if (!serialNumber) {
      try {
        const details = await getSwipeInvoiceDetails(hashId);
        serialNumber = details?.data?.invoice_details?.serial_number ||
          details?.data?.serial_number || null;
      } catch (error) {
        console.warn("Swipe invoice number lookup failed", { orderId: order.id, message: error?.message });
      }
    }

    await query(
      `UPDATE orders SET invoice_number = ?, invoice_url = ?,
         invoice_generated_at = CURRENT_TIMESTAMP, invoice_status = 'generated',
         swipe_invoice_id = ?, swipe_invoice_error = NULL,
         invoice_attempt_token = NULL, invoice_processing_started_at = NULL,
         whatsapp_invoice_status = CASE
           WHEN whatsapp_updates_consent AND NOT COALESCE(is_test_order, 0)
             THEN 'pending' ELSE 'not_applicable' END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND invoice_attempt_token = ? AND swipe_invoice_id IS NULL`,
      [serialNumber, `/api/orders/${order.id}/invoice/download`, hashId, order.id, attemptToken]
    );
    const { rows } = await query(
      `SELECT invoice_number, invoice_url, invoice_generated_at, swipe_invoice_id
       FROM orders WHERE id = ? AND swipe_invoice_id = ? LIMIT 1`,
      [order.id, hashId]
    );
    if (!rows.length) throw new Error("Invoice claim was lost before it could be saved");
    const confirmed = await loadOrderForFulfillment(order.id);
    if (
      !confirmed?.swipe_invoice_id ||
      String(confirmed.invoice_status || "").toLowerCase() !== "generated"
    ) {
      throw new Error("Swipe invoice was created but database confirmation failed");
    }
    console.log(`[Invoice] Invoice generated: ${serialNumber || hashId}`);
    console.log(`[Invoice] Database updated for ${order.order_number || order.id}`);
    return { ...rows[0], created: true, pending: false };
  } catch (error) {
    const safeError = String(error?.message || "Swipe invoice creation failed").slice(0, 1000);
    await query(
      `UPDATE orders SET invoice_status = 'failed', swipe_invoice_error = ?,
         invoice_attempt_token = NULL, invoice_processing_started_at = NULL,
         whatsapp_invoice_status = CASE
           WHEN whatsapp_updates_consent AND NOT COALESCE(is_test_order, 0)
             THEN 'failed' ELSE 'not_applicable' END,
         whatsapp_invoice_error = CASE
           WHEN whatsapp_updates_consent AND NOT COALESCE(is_test_order, 0)
             THEN ? ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND invoice_attempt_token = ?`,
      [safeError, safeError, order.id, attemptToken]
    ).catch(() => {});
    console.error(`Swipe invoice creation failed for ${order.order_number || order.id}`, { message: safeError });
    const wrapped = new Error("Swipe invoice creation failed");
    wrapped.statusCode = 502;
    throw wrapped;
  }
}

export async function getOrderInvoicePdfByOrderId(orderId) {
  const order = await loadOrderForFulfillment(orderId);
  if (!order) {
    const error = new Error("Order not found");
    error.statusCode = 404;
    throw error;
  }
  if (String(order.payment_status).trim() !== "Paid") {
    const error = new Error("Invoice is not available for this order yet");
    error.statusCode = 404;
    throw error;
  }
  if (order.swipe_invoice_id) {
    try {
      return await getSwipeInvoicePdf(order.swipe_invoice_id);
    } catch (error) {
      console.warn("[Invoice] Swipe PDF unavailable; using paid-order fallback", {
        orderId: order.id,
        message: error?.message || String(error),
      });
    }
  }
  return generateLocalInvoicePdf(order);
}

export async function refreshSwipeInvoiceHsn(orderId) {
  const order = await loadOrderForFulfillment(orderId);
  if (!order) {
    const error = new Error("Order not found");
    error.statusCode = 404;
    throw error;
  }
  if (String(order.payment_status).trim() !== "Paid") {
    const error = new Error("Order payment is not completed");
    error.statusCode = 400;
    throw error;
  }
  if (!order.swipe_invoice_id) {
    const error = new Error("Swipe invoice has not been generated");
    error.statusCode = 400;
    throw error;
  }

  const expectedHsn = String(process.env.SWIPE_PRODUCT_HSN || "90314900");
  const before = await getSwipeInvoiceDetails(order.swipe_invoice_id);
  const invoiceDetails = before?.data?.invoice_details || before?.data || {};
  const payload = buildSwipePayload(order);

  // Keep the master records already attached to this document. Updating by the
  // existing hash is what prevents a second Swipe invoice from being created.
  const existingPartyId = invoiceDetails?.party?.id || invoiceDetails?.customer?.id;
  const existingProductId = invoiceDetails?.items?.[0]?.id;
  if (existingPartyId) payload.party.id = existingPartyId;
  if (existingProductId) payload.items[0].id = existingProductId;

  // Editing an existing invoice must not resend customer notifications or add a
  // second Razorpay payment entry.
  delete payload.send_wtsp;
  delete payload.send_sms;
  delete payload.payments;

  await updateSwipeInvoiceForOrder(order, order.swipe_invoice_id, payload);
  const after = await getSwipeInvoiceDetails(order.swipe_invoice_id);
  const savedDetails = after?.data?.invoice_details || after?.data || {};
  const savedHsn = String(savedDetails?.items?.[0]?.hsn_code || "");
  if (savedHsn !== expectedHsn) {
    const error = new Error("Swipe invoice update did not persist the expected HSN code");
    error.statusCode = 502;
    throw error;
  }

  return {
    invoice_number: order.invoice_number,
    swipe_invoice_id: order.swipe_invoice_id,
    hsn_code: savedHsn,
  };
}

export async function processOrderFulfillment(orderId) {
  const invoice = await ensureSwipeInvoiceForPaidOrder(orderId);
  const order = await loadOrderForFulfillment(orderId);
  return {
    success: true,
    invoice,
    whatsapp: {
      status: order?.whatsapp_invoice_status || null,
      message_id: order?.whatsapp_invoice_message_id || null,
      sent_at: order?.whatsapp_invoice_sent_at || null,
      error: order?.whatsapp_invoice_error || null,
    },
  };
}
