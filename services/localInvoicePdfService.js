import PDFDocument from "pdfkit";

function money(value) {
  const amount = Number(value || 0);
  return `Rs. ${Number.isFinite(amount) ? amount.toFixed(2) : "0.00"}`;
}

function date(value) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleDateString("en-IN", {
        day: "2-digit", month: "2-digit", year: "numeric",
        timeZone: "Asia/Kolkata",
      });
}

function line(doc, y, color = "#D6DEE8") {
  doc.moveTo(45, y).lineTo(550, y).strokeColor(color).lineWidth(1).stroke();
}

function cell(doc, text, x, y, width, options = {}) {
  doc.fillColor(options.color || "#14213D")
    .font(options.bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(options.size || 9)
    .text(String(text ?? ""), x, y, {
      width,
      align: options.align || "left",
      lineBreak: false,
    });
}

/** Generate a paid-order invoice when Swipe PDF retrieval is unavailable. */
export async function generateLocalInvoicePdf(order) {
  const chunks = [];
  const doc = new PDFDocument({ size: "A4", margin: 45, info: {
    Title: `Invoice ${order.invoice_number || order.order_number || order.id}`,
    Author: process.env.TELAQUA_BUSINESS_NAME || "Tel-Aqua",
  } });
  doc.on("data", (chunk) => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const invoiceNumber = order.invoice_number || order.order_number || `ORDER-${order.id}`;
  const businessName = process.env.TELAQUA_BUSINESS_NAME || "Tel-Aqua";
  const productName = order.is_test_order
    ? "Tel-Aqua Razorpay Test Product"
    : process.env.TELAQUA_PRODUCT_NAME || "Tel-Aqua PH Meter";
  const quantity = Math.max(1, Number(order.quantity) || 1);
  const finalTotal = Number(order.final_total ?? order.total_amount ?? 0);
  const shipping = Number(order.shipping_amount || 0);
  const taxable = Number(order.taxable_amount ?? finalTotal - shipping);
  const gst = Number(order.gst_amount || 0);
  const gstRate = Number(order.gst_rate ?? 18);

  doc.rect(0, 0, 595.28, 112).fill("#063970");
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(25)
    .text(businessName, 45, 34, { width: 300 });
  doc.font("Helvetica").fontSize(10).text("Water-quality instruments", 45, 67);
  doc.font("Helvetica-Bold").fontSize(20).text("INVOICE", 380, 34, {
    width: 170, align: "right",
  });
  doc.font("Helvetica").fontSize(9).text(invoiceNumber, 380, 65, {
    width: 170, align: "right",
  });

  doc.fillColor("#14213D").font("Helvetica-Bold").fontSize(10)
    .text("BILLED TO", 45, 138);
  doc.font("Helvetica").fontSize(10)
    .text(String(order.customer_name || "Customer"), 45, 157)
    .text(String(order.address || ""), 45, 173, { width: 255 })
    .text([order.city, order.state, order.pincode].filter(Boolean).join(", "), 45, 189, { width: 255 })
    .text(String(order.email || ""), 45, 205, { width: 255 });

  cell(doc, "Invoice date", 355, 140, 90, { bold: true });
  cell(doc, date(order.payment_date || order.invoice_generated_at), 445, 140, 105, { align: "right" });
  cell(doc, "Order", 355, 159, 90, { bold: true });
  cell(doc, order.order_number || order.id, 445, 159, 105, { align: "right" });
  cell(doc, "Payment", 355, 178, 90, { bold: true });
  cell(doc, String(order.payment_method || "Razorpay"), 445, 178, 105, { align: "right" });
  cell(doc, "Status", 355, 197, 90, { bold: true });
  cell(doc, "PAID", 445, 197, 105, { align: "right", bold: true, color: "#008060" });

  const top = 250;
  doc.rect(45, top, 505, 28).fill("#EAF2F8");
  cell(doc, "Description", 53, top + 9, 165, { bold: true });
  cell(doc, "HSN", 220, top + 9, 70, { bold: true });
  cell(doc, "Qty", 295, top + 9, 40, { bold: true, align: "right" });
  cell(doc, "Taxable", 345, top + 9, 85, { bold: true, align: "right" });
  cell(doc, "GST", 435, top + 9, 45, { bold: true, align: "right" });
  cell(doc, "Total", 485, top + 9, 57, { bold: true, align: "right" });

  const rowY = top + 43;
  cell(doc, productName, 53, rowY, 165);
  cell(doc, process.env.SWIPE_PRODUCT_HSN || "90314900", 220, rowY, 70);
  cell(doc, quantity, 295, rowY, 40, { align: "right" });
  cell(doc, money(taxable), 345, rowY, 85, { align: "right" });
  cell(doc, `${gstRate}%`, 435, rowY, 45, { align: "right" });
  cell(doc, money(taxable + gst), 485, rowY, 57, { align: "right" });
  line(doc, rowY + 24);

  let summaryY = rowY + 52;
  cell(doc, "Taxable amount", 365, summaryY, 100);
  cell(doc, money(taxable), 465, summaryY, 77, { align: "right" });
  summaryY += 20;
  cell(doc, `GST (${gstRate}%)`, 365, summaryY, 100);
  cell(doc, money(gst), 465, summaryY, 77, { align: "right" });
  if (shipping > 0) {
    summaryY += 20;
    cell(doc, "Shipping", 365, summaryY, 100);
    cell(doc, money(shipping), 465, summaryY, 77, { align: "right" });
  }
  summaryY += 28;
  doc.rect(355, summaryY - 7, 195, 32).fill("#063970");
  cell(doc, "TOTAL PAID", 365, summaryY + 3, 90, { bold: true, size: 11, color: "#FFFFFF" });
  cell(doc, money(finalTotal), 455, summaryY + 3, 87, {
    bold: true, size: 11, color: "#FFFFFF", align: "right",
  });

  doc.fillColor("#52616B").font("Helvetica").fontSize(8)
    .text(`Razorpay payment reference: ${order.razorpay_payment_id || "-"}`, 45, 690, { width: 505 })
    .text("This fallback copy was generated from the paid order snapshot.", 45, 708, { width: 505 })
    .text("Thank you for choosing Tel-Aqua.", 45, 750, { width: 505, align: "center" });
  doc.end();

  return {
    buffer: await completed,
    contentType: "application/pdf",
    fileName: `${String(invoiceNumber).replace(/[^a-zA-Z0-9._-]/g, "-")}.pdf`,
    source: "local_fallback",
  };
}
