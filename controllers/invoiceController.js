/**
 * controllers/invoiceController.js
 *
 * Manual admin retry + admin invoice PDF download.
 */

import {
  getOrderInvoicePdfByOrderId,
  processOrderFulfillment,
  refreshSwipeInvoiceHsn,
} from "../services/invoiceService.js";

function parseOrderId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

/** POST /api/orders/:orderId/invoice */
export async function processOrderInvoice(req, res) {
  try {
    const orderId = parseOrderId(req.params.orderId);
    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Invalid order id",
      });
    }

    const result = await processOrderFulfillment(orderId);

    return res.status(200).json({
      success: true,
      message: "Invoice processed",
      invoice: {
        invoice_number: result.invoice.invoice_number,
        invoice_url: result.invoice.invoice_url,
        invoice_generated_at: result.invoice.invoice_generated_at,
        swipe_invoice_id: result.invoice.swipe_invoice_id,
      },
      whatsapp: {
        status: result.whatsapp.status,
        message_id: result.whatsapp.message_id,
        sent_at: result.whatsapp.sent_at,
        error: result.whatsapp.error,
      },
    });
  } catch (error) {
    console.error("Process order invoice error:", error?.message || error);

    const status = error?.statusCode || 500;
    if (status === 404) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }
    if (status === 400) {
      return res.status(400).json({
        success: false,
        message: error.message || "Order is not eligible for invoice",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to process invoice",
    });
  }
}

/** GET /api/orders/:orderId/invoice/download */
export async function downloadOrderInvoice(req, res) {
  try {
    const orderId = parseOrderId(req.params.orderId);
    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Invalid order id",
      });
    }

    const pdf = await getOrderInvoicePdfByOrderId(orderId);

    res.setHeader("Content-Type", pdf.contentType || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=\"order-${orderId}-invoice.pdf\"`);
    return res.status(200).send(pdf.buffer);
  } catch (error) {
    console.error("Download order invoice error:", error?.message || error);
    const status = error?.statusCode || 500;

    if (status === 404) {
      return res.status(404).json({
        success: false,
        message: error.message || "Invoice not found",
      });
    }

    return res.status(status === 502 ? 502 : 500).json({
      success: false,
      message: status === 502
        ? error.message
        : "Failed to download invoice",
    });
  }
}

/** POST /api/orders/:orderId/invoice/refresh-hsn (admin only via router) */
export async function refreshOrderInvoiceHsn(req, res) {
  try {
    const orderId = parseOrderId(req.params.orderId);
    if (!orderId) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }
    const invoice = await refreshSwipeInvoiceHsn(orderId);
    return res.status(200).json({
      success: true,
      message: "Invoice HSN updated",
      invoice,
    });
  } catch (error) {
    console.error("Refresh order invoice HSN error:", error?.message || error);
    const status = error?.statusCode || 500;
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      message: error?.message || "Failed to update invoice HSN",
    });
  }
}
