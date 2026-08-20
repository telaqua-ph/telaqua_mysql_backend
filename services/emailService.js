/**
 * Transactional email for admin inventory alerts (SMTP via nodemailer).
 * Credentials stay server-side only.
 */

import nodemailer from "nodemailer";

let transporterPromise = null;

function smtpConfigured() {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim() &&
      process.env.ADMIN_ALERT_EMAIL?.trim()
  );
}

function getTransporter() {
  if (!smtpConfigured()) return null;
  if (!transporterPromise) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporterPromise = Promise.resolve(
      nodemailer.createTransport({
        host: process.env.SMTP_HOST.trim(),
        port,
        secure: port === 465,
        auth: {
          user: process.env.SMTP_USER.trim(),
          pass: process.env.SMTP_PASS.trim(),
        },
      })
    );
  }
  return transporterPromise;
}

export function isAdminEmailConfigured() {
  return smtpConfigured();
}

/**
 * Send low-stock or out-of-stock alert to ADMIN_ALERT_EMAIL.
 * Failures are logged; never throw to callers.
 */
export async function sendInventoryAlertEmail({
  type,
  productName,
  sku,
  remaining,
  threshold,
}) {
  if (!smtpConfigured()) {
    console.warn("Inventory alert email skipped: SMTP not configured");
    return { sent: false, reason: "not_configured" };
  }

  const to = process.env.ADMIN_ALERT_EMAIL.trim();
  const from =
    process.env.SMTP_FROM?.trim() ||
    process.env.SMTP_USER?.trim() ||
    "noreply@telaqua.in";

  const isOut = type === "OUT_OF_STOCK";
  const subject = isOut
    ? `🔴 Tel-Aqua Product Out of Stock`
    : `⚠️ Tel-Aqua Low Stock Alert`;

  const lines = [
    `Product: ${productName}`,
    `SKU: ${sku}`,
    `Remaining: ${remaining} units`,
  ];
  if (!isOut && threshold != null) {
    lines.push(`Threshold: ${threshold} units`);
  }
  lines.push(
    "",
    isOut
      ? "The product is out of stock. Please add new stock."
      : "Inventory is running low. Please add new stock."
  );

  try {
    const transporter = await getTransporter();
    await transporter.sendMail({
      from,
      to,
      subject,
      text: lines.join("\n"),
    });
    return { sent: true };
  } catch (err) {
    console.error("Inventory alert email failed:", {
      type,
      sku,
      message: err?.message,
    });
    return { sent: false, reason: err?.message };
  }
}
