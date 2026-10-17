/**
 * Backend-only: send (or resend) the Fast2SMS invoice link SMS for one order.
 * Usage: node scripts/send-invoice-sms.js <order-id> [--force]
 *   --force  sends a new link even if one was already sent (the old SMS link stops working)
 */

import "dotenv/config";
import { pool } from "../config/db.js";
import { sendInvoiceLinkSms } from "../services/invoiceSmsService.js";

const orderId = Number(process.argv[2]);
const force = process.argv.includes("--force");

if (!Number.isInteger(orderId) || orderId <= 0) {
  console.error("Usage: node scripts/send-invoice-sms.js <order-id> [--force]");
  process.exitCode = 1;
} else {
  try {
    const result = await sendInvoiceLinkSms(orderId, { force });
    console.log("Result:", result);
  } catch (error) {
    console.error("Send failed:", error?.message || error);
    process.exitCode = 1;
  } finally {
    await pool.end?.().catch?.(() => {});
  }
}
