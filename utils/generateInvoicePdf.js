/**
 * utils/generateInvoicePdf.js
 *
 * Generate Tel-Aqua invoice PDF from order data.
 */

import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

const PRODUCT_NAME =
  process.env.TELAQUA_PRODUCT_NAME || "Tel-Aqua pH Meter";
const COMPANY_NAME = "Tel-Aqua";
const COMPANY_TAGLINE = "Smart Water Quality Solutions";
const COMPANY_EMAIL = process.env.TELAQUA_SUPPORT_EMAIL || "support@telaqua.com";
const COMPANY_PHONE = process.env.TELAQUA_SUPPORT_PHONE || "";

function formatCurrency(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(value) {
  if (!value) return new Date().toLocaleDateString("en-IN");
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function buildAddress(order) {
  const parts = [
    order.address,
    order.city,
    order.state,
    order.pincode,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "—";
}

/**
 * @param {object} order - Full order row from database
 * @param {string} invoiceNumber
 * @param {string} outputPath - Absolute path to write PDF
 * @returns {Promise<void>}
 */
export function generateInvoicePdf(order, invoiceNumber, outputPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const stream = fs.createWriteStream(outputPath);

    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);

    doc.pipe(stream);

    const orderLabel =
      order.order_number || `TAQ-${String(order.id).padStart(6, "0")}`;
    const invoiceDate = formatDate(
      order.invoice_generated_at || order.payment_date || new Date()
    );
    const qty = Number(order.quantity) || 1;
    const unitPrice = Number(order.unit_price);
    const totalAmount = Number(order.total_amount);
    const paymentId = order.razorpay_payment_id || "—";
    const paymentStatus = order.payment_status || "Paid";

    // Header
    doc
      .fontSize(22)
      .fillColor("#0d6efd")
      .text(COMPANY_NAME, { align: "left" });
    doc
      .fontSize(10)
      .fillColor("#444444")
      .text(COMPANY_TAGLINE);
    if (COMPANY_EMAIL) {
      doc.text(`Email: ${COMPANY_EMAIL}`);
    }
    if (COMPANY_PHONE) {
      doc.text(`Phone: ${COMPANY_PHONE}`);
    }

    doc.moveDown(1.5);
    doc
      .fontSize(16)
      .fillColor("#000000")
      .text("TAX INVOICE", { align: "right" });
    doc.fontSize(10).fillColor("#444444");
    doc.text(`Invoice No: ${invoiceNumber}`, { align: "right" });
    doc.text(`Invoice Date: ${invoiceDate}`, { align: "right" });
    doc.text(`Order ID: ${orderLabel}`, { align: "right" });

    doc.moveDown(1.5);
    doc
      .moveTo(50, doc.y)
      .lineTo(545, doc.y)
      .strokeColor("#cccccc")
      .stroke();
    doc.moveDown(0.5);

    // Bill to
    doc.fontSize(11).fillColor("#000000").text("Bill To", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#333333");
    doc.text(`Name: ${order.customer_name || "—"}`);
    doc.text(`Phone: ${order.phone || "—"}`);
    if (order.email) {
      doc.text(`Email: ${order.email}`);
    }
    doc.text(`Address: ${buildAddress(order)}`);

    doc.moveDown(1.2);

    // Table header
    const tableTop = doc.y;
    const colX = [50, 220, 300, 380, 460];
    doc.fontSize(10).fillColor("#ffffff");
    doc.rect(50, tableTop, 495, 22).fill("#0d6efd");
    doc.fillColor("#ffffff");
    doc.text("Product", colX[0] + 5, tableTop + 6, { width: 160 });
    doc.text("Qty", colX[1] + 5, tableTop + 6, { width: 60 });
    doc.text("Unit Price", colX[2] + 5, tableTop + 6, { width: 70 });
    doc.text("Amount", colX[4] + 5, tableTop + 6, { width: 80 });

    const rowY = tableTop + 28;
    doc.fillColor("#333333");
    doc.rect(50, rowY - 4, 495, 24).strokeColor("#eeeeee").stroke();
    doc.text(PRODUCT_NAME, colX[0] + 5, rowY, { width: 160 });
    doc.text(String(qty), colX[1] + 5, rowY, { width: 60 });
    doc.text(formatCurrency(unitPrice), colX[2] + 5, rowY, { width: 70 });
    doc.text(formatCurrency(totalAmount), colX[4] + 5, rowY, { width: 80 });

    if (order.promo_code) {
      doc.moveDown(1.5);
      doc.fontSize(9).fillColor("#666666");
      doc.text(`Promo code applied: ${order.promo_code}`);
      if (order.original_amount != null && order.discount_amount != null) {
        doc.text(
          `Original: ${formatCurrency(order.original_amount)} | Discount: ${formatCurrency(order.discount_amount)}`
        );
      }
    }

    doc.moveDown(2);
    doc.fontSize(11).fillColor("#000000");
    doc.text(`Total Amount: ${formatCurrency(totalAmount)}`, {
      align: "right",
    });

    doc.moveDown(1.5);
    doc.fontSize(10).fillColor("#333333");
    doc.text(`Payment Method: ${order.payment_method || "Razorpay"}`);
    doc.text(`Payment Status: ${paymentStatus}`);
    doc.text(`Razorpay Payment ID: ${paymentId}`);

    doc.moveDown(2);
    doc
      .moveTo(50, doc.y)
      .lineTo(545, doc.y)
      .strokeColor("#cccccc")
      .stroke();
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor("#888888");
    doc.text(
      "Thank you for your purchase. This is a computer-generated invoice and does not require a signature.",
      { align: "center" }
    );
    doc.text(`${COMPANY_NAME} — ${COMPANY_TAGLINE}`, { align: "center" });

    doc.end();
  });
}

/**
 * Build invoice number from order id and year.
 * @param {number} orderId
 * @returns {string}
 */
export function buildInvoiceNumber(orderId) {
  const year = new Date().getFullYear();
  return `INV-${year}-${String(orderId).padStart(6, "0")}`;
}

/**
 * @param {string} invoiceNumber
 * @returns {string}
 */
export function invoiceNumberToFileName(invoiceNumber) {
  return `${invoiceNumber}.pdf`;
}

/**
 * Resolve storage directory (absolute).
 */
export function getInvoicesStorageDir() {
  const configured = (process.env.INVOICES_STORAGE_DIR || "./public/invoices").trim();
  return path.isAbsolute(configured)
    ? configured
    : path.join(process.cwd(), configured);
}

/**
 * Build public HTTPS URL for an invoice PDF.
 * @param {string} fileName
 */
export function buildInvoicePublicUrl(fileName) {
  const base = (process.env.INVOICE_BASE_URL || "").trim().replace(/\/$/, "");
  if (!base) {
    throw new Error("INVOICE_BASE_URL is not configured");
  }
  return `${base}/${encodeURIComponent(fileName)}`;
}
