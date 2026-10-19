/**
 * routes/invoiceLink.js
 *
 * Public customer invoice link sent on WhatsApp (MyOperator template button):
 *   GET /i/<orderId>-<token>
 * The token is checked against orders.whatsapp_invoice_token_hash.
 *
 * Fast2SMS invoice SMS (DLT template URL https://<backend>/i/?{#var#}):
 *   GET /i/?<orderId>-<14 char token>   (also accepted: /i/<orderId>-<token>)
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

/** "/i/?1078-abc..." → "1078-abc..." (first raw query key, no "=value"). */
export function refFromQueryString(originalUrl) {
  const query = String(originalUrl || "").split("?")[1] || "";
  const first = query.split("&")[0].split("=")[0];
  try {
    return decodeURIComponent(first).trim();
  } catch {
    return "";
  }
}

// Shown when the base link (/i/ or /i/?) is opened without an invoice code,
// e.g. by DLT/SMS reviewers checking the whitelisted URL.
const INVOICE_INFO_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tel-Aqua Invoice Download</title></head>
<body style="font-family:Arial,sans-serif;margin:0;color:#14213D;background:#F5F8FB">
<div style="background:#063970;color:#fff;padding:32px 20px;text-align:center">
<h1 style="margin:0;font-size:26px">Tel-Aqua Invoice Download</h1>
<p style="margin:8px 0 0">AQUA AI PRIVATE LIMITED &middot; Water-quality instruments</p></div>
<div style="max-width:560px;margin:32px auto;padding:0 20px;line-height:1.6">
<p>After an order is placed on telaqua.in, the customer receives an SMS with a personal link to download the invoice for that order.</p>
<p>Each link contains a unique, secure code and opens only that customer's own invoice.</p>
<p><a href="https://telaqua.in" style="display:inline-block;background:#063970;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Visit telaqua.in</a></p>
</div></body></html>`;

// SMS link form: /i/?<orderId>-<token>
router.get("/", (req, res) => {
  const ref = refFromQueryString(req.originalUrl);
  if (!ref) {
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).type("html").send(INVOICE_INFO_PAGE);
  }
  return serveInvoiceRef(ref, res);
});

// WhatsApp link form (and SMS fallback): /i/<orderId>-<token>
router.get("/:ref", (req, res) => serveInvoiceRef(req.params.ref, res));

async function serveInvoiceRef(ref, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const whatsappRef = parseInvoiceLinkRef(ref);
  const smsRef = whatsappRef ? null : parseSmsInvoiceLinkRef(ref);
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
}

export default router;
