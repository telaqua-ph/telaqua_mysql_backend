/**
 * Backend-only: create a working Fast2SMS-style invoice link for one order WITHOUT sending an SMS.
 * Use it to get a real sample link for DLT template registration (the reviewer must be able to open it).
 *
 * Usage: node scripts/create-invoice-sms-link.js <order-id | order-number>
 *   e.g. node scripts/create-invoice-sms-link.js TAQ-001078
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

const input = String(process.argv[2] || "").trim();

async function resolveOrderId(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const { rows } = await query(`SELECT id FROM orders WHERE order_number = ? LIMIT 1`, [
    value.toUpperCase(),
  ]);
  return rows[0]?.id ? Number(rows[0].id) : null;
}

async function printLatestOrders() {
  const { rows } = await query(
    `SELECT id, order_number, payment_mode, payment_status FROM orders ORDER BY id DESC LIMIT 10`
  );
  console.log("Latest orders (id → order number):");
  for (const row of rows) {
    console.log(`  ${row.id} → ${row.order_number || "-"}  (${row.payment_mode || "-"}, ${row.payment_status || "-"})`);
  }
}

if (!input) {
  console.error("Usage: node scripts/create-invoice-sms-link.js <order-id | order-number>");
  process.exitCode = 1;
} else {
  try {
    const orderId = await resolveOrderId(input);
    const order = orderId ? await loadOrderForFulfillment(orderId) : null;
    if (!order) {
      console.error(`Order ${input} not found in database ${process.env.DB_NAME || ""}.`);
      await printLatestOrders();
      throw new Error("Run again with one of the ids or order numbers above.");
    }
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
