/** Razorpay webhook: raw-body signature verification and idempotent payment updates. */

import crypto from "node:crypto";
import { getRazorpayClient } from "../config/razorpay.js";
import {
  confirmCapturedRazorpayPayment,
  expectedAmountPaise,
  fetchCapturedPaymentForOrder,
  logPaymentEvent,
  markRazorpayPaymentFailed,
  normalizeRazorpayMethod,
  triggerOrderFulfillmentAsync,
} from "../services/confirmRazorpayPayment.js";
import { query } from "../config/db.js";
import { notifyPaymentFailedCheckoutReminder } from "../services/checkoutReminderService.js";

function validSignature(rawBody, received, secret) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(String(received || ""), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function resolveCapturedPayment(event, razorpayOrderId) {
  const fromPayload = event?.payload?.payment?.entity;
  if (
    fromPayload?.id &&
    String(fromPayload.status || "").toLowerCase() === "captured"
  ) {
    return fromPayload;
  }
  try {
    return await fetchCapturedPaymentForOrder(razorpayOrderId);
  } catch (err) {
    console.warn("Razorpay fetchPayments failed", {
      razorpayOrderId,
      message: err?.error?.description || err?.message,
    });
    return null;
  }
}

async function loadOrderExpectedAmount(razorpayOrderId) {
  const { rows } = await query(
    `SELECT id, order_number, COALESCE(final_total, total_amount) AS expected_total
     FROM orders WHERE razorpay_order_id = ? LIMIT 1`,
    [razorpayOrderId]
  );
  if (rows.length) return rows[0];
  try {
    const rzOrder = await getRazorpayClient().orders.fetch(razorpayOrderId);
    const dbId = Number(rzOrder?.notes?.website_order_db_id);
    if (!Number.isInteger(dbId) || dbId <= 0) return null;
    const byId = await query(
      `SELECT id, order_number, COALESCE(final_total, total_amount) AS expected_total
       FROM orders WHERE id = ? LIMIT 1`,
      [dbId]
    );
    return byId.rows[0] || null;
  } catch {
    return null;
  }
}

/** POST /api/webhooks/razorpay */
export async function handleRazorpayWebhook(req, res) {
  const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    logPaymentEvent("WEBHOOK_PROCESSING_FAILED", { reason: "RAZORPAY_WEBHOOK_SECRET missing" });
    return res.status(503).json({ success: false, message: "Webhook is not configured" });
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
  const signature = req.headers["x-razorpay-signature"];
  if (!signature || !validSignature(rawBody, signature, secret)) {
    logPaymentEvent("INVALID_WEBHOOK_SIGNATURE", {});
    return res.status(401).json({ success: false, message: "Invalid webhook signature" });
  }
  logPaymentEvent("WEBHOOK_SIGNATURE_VERIFIED", {});

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ success: false, message: "Invalid webhook payload" });
  }

  const eventType = String(event?.event || "");
  logPaymentEvent("RAZORPAY_WEBHOOK_RECEIVED", { eventType });

  if (!["payment.captured", "order.paid", "payment.failed"].includes(eventType)) {
    return res.status(200).json({ success: true, ignored: true });
  }

  const payloadPayment = event?.payload?.payment?.entity || {};
  const razorpayOrderId = String(
    payloadPayment.order_id || event?.payload?.order?.entity?.id || ""
  );
  const eventId = String(
    req.headers["x-razorpay-event-id"] ||
      `${eventType}:${payloadPayment.id || razorpayOrderId}:${payloadPayment.status || "unknown"}`
  );

  if (!razorpayOrderId) {
    logPaymentEvent("ORDER_NOT_FOUND", {
      eventType,
      razorpayPaymentId: payloadPayment.id || null,
      paymentAmount: payloadPayment.amount || null,
      reason: "missing_razorpay_order_id",
    });
    return res.status(400).json({ success: false, message: "Missing Razorpay order id" });
  }

  try {
    if (eventType === "payment.failed") {
      const failed = await markRazorpayPaymentFailed(razorpayOrderId, eventId, eventType);
      if (failed.status === "not_found") {
        logPaymentEvent("ORDER_NOT_FOUND", {
          eventType,
          razorpayOrderId,
          razorpayPaymentId: payloadPayment.id || null,
          paymentAmount: payloadPayment.amount || null,
        });
        return res.status(404).json({ success: false, message: "Order not found" });
      }
      if (failed.status === "failed" && failed.order) {
        notifyPaymentFailedCheckoutReminder(failed.order);
      }
      return res.status(200).json({ success: true });
    }

    logPaymentEvent("PAYMENT_VERIFICATION_STARTED", {
      eventType,
      razorpayOrderId,
      razorpayPaymentId: payloadPayment.id || null,
    });

    const captured = await resolveCapturedPayment(event, razorpayOrderId);
    if (!captured?.id || String(captured.status || "").toLowerCase() !== "captured") {
      logPaymentEvent("PAYMENT_CAPTURED", {
        eventType,
        razorpayOrderId,
        captured: false,
      });
      // Authorized/created — wait for payment.captured. Not an error.
      return res.status(200).json({ success: true, pending_capture: true });
    }

    logPaymentEvent("PAYMENT_CAPTURED", {
      eventType,
      razorpayOrderId,
      razorpayPaymentId: captured.id,
      paymentAmount: captured.amount,
    });

    const neonOrder = await loadOrderExpectedAmount(razorpayOrderId);
    if (neonOrder) {
      const expectedPaise = expectedAmountPaise(neonOrder);
      if (
        Number(captured.amount) !== expectedPaise ||
        String(captured.currency || "INR").toUpperCase() !== "INR"
      ) {
        logPaymentEvent("PAYMENT_AMOUNT_MISMATCH", {
          orderId: neonOrder.id,
          orderNumber: neonOrder.order_number,
          razorpayOrderId,
          razorpayPaymentId: captured.id,
          expectedPaise,
          paymentAmount: captured.amount,
          eventType,
        });
        return res.status(400).json({ success: false, message: "Payment details do not match order" });
      }
    }

    const result = await confirmCapturedRazorpayPayment({
      razorpayOrderId,
      razorpayPaymentId: String(captured.id),
      paymentMethod: normalizeRazorpayMethod(captured.method),
      webhookEventId: eventId,
      webhookEventType: eventType,
      capturedAmount: captured.amount,
      capturedCurrency: captured.currency,
    });

    if (result.status === "not_found") {
      logPaymentEvent("ORDER_NOT_FOUND", {
        eventType,
        razorpayOrderId,
        razorpayPaymentId: captured.id,
        paymentAmount: captured.amount,
      });
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    if (result.status === "amount_mismatch") {
      return res.status(400).json({ success: false, message: "Payment details do not match order" });
    }

    if (result.status === "insufficient_stock") {
      return res.status(409).json({
        success: false,
        message: "Insufficient stock to confirm order",
        available: result.available,
      });
    }

    if (result.status === "ineligible") {
      return res.status(400).json({ success: false, message: "Order is not eligible for payment confirmation" });
    }

    if (result.status === "marked_paid" || result.status === "already_paid") {
      triggerOrderFulfillmentAsync(result.order?.id);
    }

    return res.status(200).json({ success: true, status: result.status });
  } catch (error) {
    logPaymentEvent("WEBHOOK_PROCESSING_FAILED", {
      eventType,
      razorpayOrderId,
      razorpayPaymentId: payloadPayment.id || null,
      message: error?.message,
      code: error?.code,
    });
    return res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
}
