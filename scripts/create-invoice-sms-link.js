/**
 * Backend-only: create a working Fast2SMS-style invoice link for one order WITHOUT sending an SMS.
 * Use it to get a real sample link for DLT template registration (the reviewer must be able to open it).
 *
 * Usage: node scripts/create-invoice-sms-link.js <order-id>
 * Prints: https://<backend>/i/?<orderId>-<token>  and the <orderId>-<token> part for the DLT variable.
 *
 * Note: any previous SMS link for this order stops working, and a later automatic SMS
 * for this order is skipped (it counts as already sent). Use your own test order.
 */

import "dotenv/config";
import { pool, query } from "../config/db.js";
import {
  buildSmsInvoiceLink,
  ensureSmsInvoiceColumns,
  generateSmsInvoiceToken,
  getFast2SmsConfig,
  hashSmsInvoiceToken,
} from "../services/invoiceSmsService.js";
import { canGenerateOrderInvoice, loadOrderForFulfillment } from "../services/invoiceService.js";

const orderId = Number(process.argv[2]);

if (!Number.isInteger(orderId) || orderId <= 0) {
  console.error("Usage: node scripts/create-invoice-sms-link.js <order-id>");
  process.exitCode = 1;
} else {
  try {
    const order = await loadOrderForFulfillment(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);
    if (!canGenerateOrderInvoice(order)) {
      throw new Error(`Order ${orderId} is not eligible for an invoice (unpaid prepaid order)`);
    }
    await ensureSmsInvoiceColumns();
    const token = generateSmsInvoiceToken();
    const ref = `${orderId}-${token}`;
    await query(`UPDATE orders SET sms_invoice_token_hash = ? WHERE id = ?`, [
      hashSmsInvoiceToken(token),
      orderId,
    ]);
    const link = buildSmsInvoiceLink(getFast2SmsConfig().linkBase, ref);
    console.log(`Order:         ${order.order_number || orderId}`);
    console.log(`Link:          ${link}`);
    console.log(`DLT variable:  ${ref}`);
  } catch (error) {
    console.error("Failed:", error?.message || error);
    process.exitCode = 1;
  } finally {
    await pool.end?.().catch?.(() => {});
  }
}
