/**
 * routes/invoiceLink.js
 *
 * Public customer invoice link sent on WhatsApp (MyOperator template button):
 *   GET /i/<orderId>-<token>
 * The token is checked against orders.whatsapp_invoice_token_hash.
 *
 * Fast2SMS invoice SMS (DLT template URL https://<backend>/i/{#var#}):
 *   GET /i/<orderId>-<14 char token>
 * The token is checked against orders.sms_invoice_token_hash.
 */

import { Router } from "express";
import { query } from "../config/db.js";
import {
  ensureSwipeInvoiceForPaidOrder,
  getOrderInvoicePdfByOrderId,
} from "../services/invoiceService.js";
import {
  ensureInvoiceLinkTokenColumn,
  isValidInvoiceLinkToken,
  parseInvoiceLinkRef,
} from "../services/invoiceWhatsAppService.js";
import {
  ensureSmsInvoiceColumns,
  isValidSmsInvoiceToken,
  parseSmsInvoiceLinkRef,
} from "../services/invoiceSmsService.js";

const router = Router();

function messagePage(message) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tel-Aqua Invoice</title></head>
<body style="font-family:Arial,sans-serif;padding:40px 16px;text-align:center;color:#14213D">
<h3>${message}</h3></body></html>`;
}

router.get("/:ref", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const whatsappRef = parseInvoiceLinkRef(req.params.ref);
  const smsRef = whatsappRef ? null : parseSmsInvoiceLinkRef(req.params.ref);
  const parsed = whatsappRef || smsRef;
  if (!parsed) {
    return res.status(404).type("html").send(messagePage("This invoice link is invalid."));
  }

  try {
    let valid = false;
    if (whatsappRef) {
      await ensureInvoiceLinkTokenColumn();
      const { rows } = await query(
        `SELECT whatsapp_invoice_token_hash FROM orders WHERE id = ? LIMIT 1`,
        [parsed.orderId]
      );
      valid = rows.length > 0 &&
        isValidInvoiceLinkToken(rows[0].whatsapp_invoice_token_hash, parsed.token);
    } else {
      await ensureSmsInvoiceColumns();
      const { rows } = await query(
        `SELECT sms_invoice_token_hash FROM orders WHERE id = ? LIMIT 1`,
        [parsed.orderId]
      );
      valid = rows.length > 0 &&
        isValidSmsInvoiceToken(rows[0].sms_invoice_token_hash, parsed.token);
    }
    if (!valid) {
      return res
        .status(404)
        .type("html")
        .send(messagePage("This invoice link is invalid or has expired."));
    }

    try {
      await ensureSwipeInvoiceForPaidOrder(parsed.orderId);
    } catch {
      // getOrderInvoicePdfByOrderId falls back to a locally generated invoice PDF.
    }

    const pdf = await getOrderInvoicePdfByOrderId(parsed.orderId);
    res.setHeader("Content-Type", pdf.contentType || "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="telaqua-invoice-${parsed.orderId}.pdf"`
    );
    return res.status(200).send(pdf.buffer);
  } catch (error) {
    if (/being generated/i.test(String(error?.message || ""))) {
      return res
        .status(202)
        .type("html")
        .send(messagePage("Your invoice is being prepared. Please try again in a minute."));
    }
    console.error("[InvoiceLink] Failed to serve invoice", {
      orderId: parsed.orderId,
      message: error?.message || String(error),
    });
    return res
      .status(500)
      .type("html")
      .send(messagePage("We could not load your invoice right now. Please try again later."));
  }
});

export default router;
