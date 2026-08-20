/**
 * Backend-only one-order Swipe diagnostic/retry.
 * Usage: node scripts/retry-swipe-invoice.js <paid-order-id>
 */

import "dotenv/config";
import { pool } from "../config/db.js";
import {
  ensureSwipeInvoiceForPaidOrder,
  getOrderInvoicePdfByOrderId,
  loadOrderForFulfillment,
} from "../services/invoiceService.js";
import { getSwipeConfigurationStatus } from "../services/swipeService.js";

const orderId = Number(process.argv[2]);
if (!Number.isInteger(orderId) || orderId <= 0) {
  console.error("Usage: node scripts/retry-swipe-invoice.js <paid-order-id>");
  process.exitCode = 1;
} else {
  try {
    const config = getSwipeConfigurationStatus();
    console.log(`SWIPE_API_KEY loaded: ${config.apiKeyLoaded}`);
    console.log(`Swipe endpoint: ${config.baseUrl}/doc`);
    const before = await loadOrderForFulfillment(orderId);
    console.log("Before:", {
      order_id: before?.id,
      payment_status: before?.payment_status,
      invoice_status: before?.invoice_status,
      swipe_hash_id: before?.swipe_invoice_id ? "present" : null,
      swipe_invoice_number: before?.invoice_number || null,
      swipe_invoice_error: before?.swipe_invoice_error || null,
    });
    const invoice = await ensureSwipeInvoiceForPaidOrder(orderId);
    const after = await loadOrderForFulfillment(orderId);
    console.log("SWIPE DIRECT TEST: PASS");
    console.log("After:", {
      payment_status: after.payment_status,
      invoice_status: after.invoice_status,
      swipe_hash_id: after.swipe_invoice_id ? "present" : null,
      swipe_invoice_number: after.invoice_number,
      created: invoice.created,
    });
    const pdf = await getOrderInvoicePdfByOrderId(orderId);
    console.log("PDF download: PASS", {
      content_type: pdf.contentType,
      bytes: pdf.buffer.length,
    });
  } catch (error) {
    const after = await loadOrderForFulfillment(orderId).catch(() => null);
    console.error("SWIPE DIRECT TEST: FAIL");
    console.error({
      http_status: error?.statusCode || null,
      message: error?.message || String(error),
      invoice_status: after?.invoice_status || null,
      swipe_invoice_error: after?.swipe_invoice_error || null,
    });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
