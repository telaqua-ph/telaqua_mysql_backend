/**
 * controllers/codAdvanceController.js
 *
 * Website COD with a ₹99 non-refundable advance delivery fee paid via Razorpay.
 * The COD order is created only after the ₹99 payment is verified server-side.
 */

import { query } from "../config/db.js";
import { getRazorpayClient } from "../config/razorpay.js";
import { buildFinancialSnapshot, resolveOrderPricing } from "../services/orderPricing.js";
import { assertStockAvailable } from "../services/inventoryService.js";
import { ensureWhatsappConsentColumns } from "../services/whatsappConsent.js";
import { isMissingTableError } from "../lib/dbErrors.js";
import {
  COD_ADVANCE_DESCRIPTION,
  COD_ADVANCE_FEE_PAISE,
  codAdvanceBreakdown,
  createCodAdvanceCheckout,
  finalizeCodAdvancePayment,
  listCodAdvanceIssues,
  listUnpaidCodCheckouts,
  dismissUnpaidCodCheckout,
  markCodAdvanceRefunded,
} from "../services/codAdvanceService.js";
import { createInvoiceAccessToken, validateWebsiteCodOrder } from "./orderController.js";
import { isValidRazorpaySignature } from "./paymentController.js";

const MIGRATION_MESSAGE = "COD advance tables are missing. Run node scripts/migrate-cod-advance-fee.js";

function isMissingSchema(error) {
  return isMissingTableError(error) ||
    (error?.code === "ER_BAD_FIELD_ERROR" && /cod_advance|cod_amount_due|cod_fee_declaration/i.test(String(error?.message)));
}

function orderSummary(order) {
  const breakdown = codAdvanceBreakdown(order.cod_amount_due ?? order.final_total ?? order.total_amount);
  return {
    db_order_id: order.id,
    order_number: order.order_number,
    payment_mode: "cod",
    payment_status: order.payment_status,
    order_status: order.order_status,
    advance_payment_status: order.cod_advance_status,
    razorpay_payment_id: order.cod_advance_razorpay_payment_id,
    ...breakdown,
  };
}

/** POST /api/orders/website-cod/advance/create-order */
export async function createCodAdvanceOrder(req, res) {
  try {
    const body = req.body;
    const validation = validateWebsiteCodOrder(body);
    if (validation.error) {
      return res.status(400).json({ success: false, message: validation.error });
    }
    if (body.cod_fee_declaration_accepted !== true) {
      return res.status(400).json({
        success: false,
        message: "Please accept that the ₹99 advance delivery charge is non-refundable.",
      });
    }

    const orderData = validation.data;
    const pricing = await resolveOrderPricing(orderData);
    if (pricing.error) {
      return res.status(400).json({ success: false, message: pricing.error });
    }
    const stockCheck = await assertStockAvailable(orderData.quantity);
    if (!stockCheck.ok) {
      return res.status(409).json({ success: false, message: stockCheck.message, available: stockCheck.available });
    }
    await ensureWhatsappConsentColumns();

    const financial = buildFinancialSnapshot(pricing);
    const invoiceAccess = createInvoiceAccessToken();
    const { attemptId, razorpayOrder } = await createCodAdvanceCheckout({
      orderData,
      productAmount: financial.finalTotal,
      invoiceAccessHash: invoiceAccess.hash,
    });

    return res.status(201).json({
      success: true,
      cod_advance_id: attemptId,
      order_id: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      description: COD_ADVANCE_DESCRIPTION,
      phone: orderData.phone,
      email: orderData.email,
      promo_code: pricing.promo_code,
      discount_amount: pricing.discount_amount,
      invoice_access_token: invoiceAccess.token,
      ...codAdvanceBreakdown(financial.finalTotal),
    });
  } catch (error) {
    if (isMissingSchema(error)) return res.status(503).json({ success: false, message: MIGRATION_MESSAGE });
    console.error("COD advance create-order error:", error);
    return res.status(500).json({ success: false, message: "We could not start the ₹99 payment. Please try again." });
  }
}

/** POST /api/orders/website-cod/advance/verify */
export async function verifyCodAdvancePayment(req, res) {
  const body = req.body || {};
  const razorpayOrderId = String(body.razorpay_order_id || "").trim();
  const razorpayPaymentId = String(body.razorpay_payment_id || "").trim();
  const signature = String(body.razorpay_signature || "").trim();
  if (!razorpayOrderId || !razorpayPaymentId || !signature) {
    return res.status(400).json({ success: false, message: "razorpay_order_id, razorpay_payment_id and razorpay_signature are required" });
  }

  try {
    if (!isValidRazorpaySignature(razorpayOrderId, razorpayPaymentId, signature)) {
      return res.status(400).json({ success: false, message: "Payment verification failed. Your COD order was not placed." });
    }

    const result = await finalizeCodAdvancePayment({ razorpayOrderId, razorpayPaymentId, source: "verify" });
    if (result.status === "created" || result.status === "already_created") {
      return res.status(result.status === "created" ? 201 : 200).json({
        success: true,
        message: "COD order confirmed. ₹99 delivery charge received.",
        ...orderSummary(result.order),
      });
    }
    if (result.status === "not_found") {
      return res.status(404).json({ success: false, message: "This payment does not match a COD checkout." });
    }
    if (result.status === "order_failed") {
      return res.status(409).json({
        success: false,
        code: "COD_ADVANCE_ORDER_FAILED",
        message: "Your ₹99 payment was received, but we could not confirm the order " +
          `(${result.reason}). Our team will contact you to complete or refund it. Please do not pay again.`,
      });
    }
    return res.status(400).json({
      success: false,
      message: `Payment could not be verified (${result.reason}). Your COD order was not placed.`,
    });
  } catch (error) {
    if (isMissingSchema(error)) return res.status(503).json({ success: false, message: MIGRATION_MESSAGE });
    console.error("COD advance verify error:", error);
    return res.status(500).json({
      success: false,
      message: "We could not confirm your payment right now. If ₹99 was debited, do not pay again — it will be confirmed automatically.",
    });
  }
}

/** GET /api/orders/cod-advance/issues (admin) — paid advances without an order. */
export async function listCodAdvanceIssuesHandler(req, res) {
  try {
    return res.json({ success: true, issues: await listCodAdvanceIssues() });
  } catch (error) {
    if (isMissingSchema(error)) return res.status(503).json({ success: false, message: MIGRATION_MESSAGE });
    console.error("COD advance issues error:", error);
    return res.status(500).json({ success: false, message: "Unable to load COD advance payments." });
  }
}

/** GET /api/orders/cod-advance/unpaid (admin) — Leads: COD checkouts left without paying the ₹99. */
export async function listUnpaidCodCheckoutsHandler(req, res) {
  try {
    return res.json({ success: true, checkouts: await listUnpaidCodCheckouts() });
  } catch (error) {
    if (isMissingSchema(error)) return res.status(503).json({ success: false, message: MIGRATION_MESSAGE });
    console.error("Unpaid COD checkouts error:", error);
    return res.status(500).json({ success: false, message: "Unable to load unpaid COD checkouts." });
  }
}

/** DELETE /api/orders/cod-advance/unpaid/:id (admin) — remove a lead from the Leads page. */
export async function deleteUnpaidCodCheckoutHandler(req, res) {
  try {
    const dismissed = await dismissUnpaidCodCheckout(req.params.id);
    if (!dismissed) return res.status(404).json({ success: false, message: "Lead not found or already removed." });
    return res.json({ success: true, dismissed });
  } catch (error) {
    if (isMissingSchema(error)) return res.status(503).json({ success: false, message: MIGRATION_MESSAGE });
    console.error("Delete lead error:", error);
    return res.status(500).json({ success: false, message: "Unable to delete the lead." });
  }
}

/** POST /api/orders/cod-advance/:razorpayOrderId/retry (admin) — re-verify and create the order. */
export async function retryCodAdvanceOrder(req, res) {
  try {
    const razorpayOrderId = String(req.params.razorpayOrderId || "").trim();
    // Allow a retry of a previously failed order creation.
    await query(
      `UPDATE cod_advance_payments SET failure_reason = NULL WHERE razorpay_order_id = ? AND status = 'paid_order_failed'`,
      [razorpayOrderId]
    );
    const result = await finalizeCodAdvancePayment({ razorpayOrderId, source: "admin_retry" });
    if (result.status === "created" || result.status === "already_created") {
      return res.json({ success: true, ...orderSummary(result.order) });
    }
    return res.status(409).json({ success: false, status: result.status, message: result.reason || "Order could not be created" });
  } catch (error) {
    console.error("COD advance retry error:", error);
    return res.status(500).json({ success: false, message: "Retry failed." });
  }
}

/**
 * POST /api/orders/cod-advance/:id/refund (admin)
 * Refunds the ₹99 in Razorpay for an advance that never became an order, then records it.
 */
export async function refundCodAdvance(req, res) {
  try {
    const attemptId = Number(req.params.id);
    if (!Number.isInteger(attemptId) || attemptId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }
    const { rows } = await query(
      `SELECT razorpay_payment_id, status, order_id FROM cod_advance_payments WHERE id = ?`,
      [attemptId]
    );
    const attempt = rows[0];
    if (!attempt || attempt.status !== "paid_order_failed" || attempt.order_id || !attempt.razorpay_payment_id) {
      return res.status(409).json({ success: false, message: "Only paid advances without an order can be refunded here." });
    }
    const refund = await getRazorpayClient().payments.refund(attempt.razorpay_payment_id, {
      amount: COD_ADVANCE_FEE_PAISE,
      notes: { reason: "COD order could not be created" },
    });
    await markCodAdvanceRefunded(attemptId, `Refunded: ${refund?.id || "razorpay"}`);
    return res.json({ success: true, refund_id: refund?.id || null });
  } catch (error) {
    console.error("COD advance refund error:", error?.error?.description || error?.message);
    return res.status(500).json({ success: false, message: "Refund failed. Refund it from the Razorpay dashboard instead." });
  }
}
