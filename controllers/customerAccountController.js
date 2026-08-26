import crypto from "node:crypto";
import { pool, query } from "../config/db.js";
import { isMissingTableError } from "../lib/dbErrors.js";
import {
  customerSessionExpiry,
  generateOtp,
  getCustomerAuthConfigurationStatus,
  hashOtp,
  hashRequestIp,
  signCustomerToken,
  verifyOtpHash,
} from "../lib/customerAuth.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";
import {
  getInteraktOtpConfigurationStatus,
  sendOtp,
} from "../services/interaktOtpService.js";
import { getInteraktConfigurationStatus } from "../services/interaktService.js";
import {
  dispatchInventoryAlertEmails,
  restoreStockForCancellation,
} from "../services/inventoryService.js";
import { normalizePaymentMode } from "../services/paymentMode.js";
import { isCustomerCodCancellable, evaluateCustomerCodCancel } from "../services/customerCodCancel.js";

const OTP_EXPIRY_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MIN_REQUEST_SECONDS = 60;
const OTP_PHONE_WINDOW_MINUTES = 15;
const OTP_PHONE_WINDOW_LIMIT = 5;
const OTP_IP_WINDOW_MINUTES = 60;
const OTP_IP_WINDOW_LIMIT = 20;

// Compare last 10 digits only; BINARY avoids MySQL collation mismatches on Hostinger.
const PHONE_MATCH_SQL = `
  BINARY RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 10) = ?
`;

const SAFE_ORDER_COLUMNS = `
  id, order_number, created_at, updated_at, quantity, unit_price,
  COALESCE(final_total, total_amount) AS total_amount,
  payment_method, payment_mode, payment_status, order_status,
  shipment_status, waybill, delhivery_shipment_id,
  shipment_created_at, shipment_confirmed_at,
  pickup_status, pickup_requested_at, tracking_status, tracking_updated_at,
  invoice_number, invoice_generated_at, invoice_status, swipe_invoice_id,
  customer_name, phone, email, address, city, state, pincode
`;

function isSecureRequest(req) {
  if (process.env.NODE_ENV !== "production") return true;
  const forwarded = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0].trim().toLowerCase();
  return req.secure || forwarded === "https";
}

function validatePhone(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid JSON body" };
  }
  const countryCode = String(body.countryCode || "+91").replace(/\s/g, "");
  if (body.phoneNumber !== undefined && countryCode !== "+91" && countryCode !== "91") {
    return { error: "Enter a valid Indian mobile number" };
  }
  const normalized = normalizeIndianPhone(body.phone ?? body.phoneNumber);
  if (normalized.error) return { error: "Enter a valid Indian mobile number" };
  return { phone: normalized.phoneNumber };
}

function apiOrigin(req) {
  const configured = String(process.env.BACKEND_BASE_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  const forwarded = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0].trim();
  return `${forwarded || req.protocol || "https"}://${req.get("host")}`;
}

function mergeShipmentFields(order, shipment = null) {
  if (!order) return order;
  if (!shipment) return order;
  return {
    ...order,
    waybill: order.waybill || shipment.waybill_number || shipment.waybill,
    delhivery_shipment_id:
      order.delhivery_shipment_id || shipment.shipment_id,
    shipment_created_at: order.shipment_created_at || shipment.shipment_created_at,
    shipment_status: order.shipment_status || shipment.shipment_status,
    pickup_requested_at: order.pickup_requested_at || shipment.pickup_requested_at,
    fulfillment_status: order.fulfillment_status || shipment.fulfillment_status,
  };
}

function safeOrder(order, req, detailed = false, shipment = null) {
  const merged = mergeShipmentFields(order, shipment);
  const paid = String(merged.payment_status || "").toLowerCase() === "paid";
  const invoiceAvailable = paid || Boolean(merged.swipe_invoice_id) ||
    String(merged.invoice_status || "").toLowerCase() === "generated";
  const result = {
    id: merged.id,
    order_number: merged.order_number,
    created_at: merged.created_at,
    updated_at: merged.updated_at,
    quantity: merged.quantity,
    unit_price: Number(merged.unit_price),
    total_amount: Number(merged.total_amount),
    payment_method: merged.payment_method,
    payment_mode: normalizePaymentMode(merged),
    payment_status: merged.payment_status,
    order_status: merged.order_status,
    shipment_status: merged.shipment_status,
    tracking_number: merged.waybill || null,
    waybill: merged.waybill || null,
    delhivery_shipment_id: merged.delhivery_shipment_id || null,
    tracking_status: merged.tracking_status || null,
    tracking_updated_at: merged.tracking_updated_at || null,
    shipment_created_at: merged.shipment_created_at || null,
    shipment_confirmed_at: merged.shipment_confirmed_at || null,
    pickup_requested_at: merged.pickup_requested_at || null,
    can_cancel: isCustomerCodCancellable(merged, shipment),
    invoice_available: invoiceAvailable,
    invoice_number: merged.invoice_number || null,
    invoice_status: merged.invoice_status || null,
    invoice_generated_at: merged.invoice_generated_at || null,
    invoice_url: invoiceAvailable
      ? `${apiOrigin(req)}/api/payment/invoice-download?order_id=${encodeURIComponent(merged.id)}`
      : null,
  };
  if (detailed) {
    result.delivery_address = {
      name: merged.customer_name,
      address: merged.address,
      city: merged.city,
      state: merged.state,
      pincode: merged.pincode,
    };
  }
  return result;
}

async function loadLatestShipmentsMap(orderIds) {
  const ids = orderIds.map((id) => Number(id)).filter(Number.isInteger);
  if (!ids.length) return new Map();
  try {
    const placeholders = ids.map(() => "?").join(",");
    const { rows } = await query(
      `SELECT order_id, waybill_number, shipment_id, shipment_created_at,
              fulfillment_status, shipment_status, pickup_requested_at
       FROM shipments
       WHERE sequence_no = 1 AND order_id IN (${placeholders})`,
      ids
    );
    return new Map(rows.map((row) => [Number(row.order_id), row]));
  } catch (error) {
    if (isMissingTableError(error)) return new Map();
    throw error;
  }
}

async function loadLatestShipment(orderId, client = null) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const run = client ? client.query.bind(client) : query;
  try {
    const { rows } = await run(
      `SELECT order_id, waybill_number, shipment_id, shipment_created_at,
              fulfillment_status, shipment_status, pickup_requested_at
       FROM shipments
       WHERE sequence_no = 1 AND order_id = ?
       LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

async function loadOwnedOrder(orderId, phone) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await query(
    `SELECT ${SAFE_ORDER_COLUMNS} FROM orders
     WHERE id = ? AND ${PHONE_MATCH_SQL}
     LIMIT 1`,
    [id, phone]
  );
  return rows[0] || null;
}

async function missingOwnedOrderResponse(orderId, res) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }
  const { rowCount } = await query("SELECT 1 FROM orders WHERE id = ? LIMIT 1", [id]);
  if (rowCount > 0) {
    return res.status(403).json({
      success: false,
      message: "You are not allowed to access this order",
    });
  }
  return res.status(404).json({ success: false, message: "Order not found" });
}

/** POST /api/customer/auth/request-otp */
export async function requestCustomerOtp(req, res) {
  if (!isSecureRequest(req)) {
    return res.status(400).json({ success: false, message: "HTTPS is required" });
  }
  const validated = validatePhone(req.body);
  if (validated.error) {
    return res.status(400).json({ success: false, message: validated.error });
  }

  const phone = validated.phone;
  let otp;
  let otpHash;
  let ipHash;
  let client;
  let otpId;
  try {
    otp = generateOtp();
    otpHash = hashOtp(phone, otp);
    ipHash = hashRequestIp(req.ip);
    client = await pool.connect();
    await client.query("BEGIN");
    const lockName = `customer_otp:${phone}`;
    const lock = await client.query("SELECT GET_LOCK(?, 10) AS locked", [lockName]);
    if (!lock.rows[0]?.locked) {
      await client.query("ROLLBACK");
      return res.status(503).json({
        success: false,
        message: "Customer authentication is temporarily unavailable",
      });
    }
    const rate = await client.query(
      `SELECT
         CAST(SUM(CASE WHEN phone = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE) THEN 1 ELSE 0 END) AS SIGNED) AS phone_count,
         CAST(SUM(CASE WHEN request_ip_hash = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE) THEN 1 ELSE 0 END) AS SIGNED) AS ip_count,
         TIMESTAMPDIFF(SECOND, MAX(CASE WHEN phone = ? THEN created_at END), CURRENT_TIMESTAMP) AS seconds_since_last
       FROM customer_auth_otps`,
      [phone, OTP_PHONE_WINDOW_MINUTES, ipHash, OTP_IP_WINDOW_MINUTES, phone]
    );
    const limits = rate.rows[0];
    if (
      limits.seconds_since_last !== null &&
      Number(limits.seconds_since_last) < OTP_MIN_REQUEST_SECONDS
    ) {
      await client.query("ROLLBACK");
      return res.status(429).json({
        success: false,
        message: "Please wait before requesting another OTP",
      });
    }
    if (limits.phone_count >= OTP_PHONE_WINDOW_LIMIT || limits.ip_count >= OTP_IP_WINDOW_LIMIT) {
      await client.query("ROLLBACK");
      return res.status(429).json({
        success: false,
        message: "Too many OTP requests. Please try again later.",
      });
    }

    await client.query(
      `UPDATE customer_auth_otps SET invalidated_at = CURRENT_TIMESTAMP
       WHERE phone = ? AND verified_at IS NULL AND invalidated_at IS NULL`,
      [phone]
    );
    const inserted = await client.query(
      `INSERT INTO customer_auth_otps
         (phone, otp_hash, expires_at, request_ip_hash)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?)`,
      [phone, otpHash, OTP_EXPIRY_MINUTES, ipHash]
    );
    otpId = inserted.insertId;
    await client.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
    await client.query("COMMIT");
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Customer OTP request initialization/database error:", {
      message: error?.message || String(error),
      code: error?.code || null,
      authConfig: getCustomerAuthConfigurationStatus(),
    });
    return res.status(503).json({
      success: false,
      message: "Customer authentication is temporarily unavailable",
    });
  } finally {
    if (client) client.release();
  }

  try {
    const sent = await sendOtp(phone, otp);
    await query(
      `UPDATE customer_auth_otps SET provider_message_id = ? WHERE id = ?`,
      [otpId, sent.messageId ? String(sent.messageId) : null]
    );
    return res.status(200).json({ success: true, message: "OTP sent successfully" });
  } catch (error) {
    await query(
      `UPDATE customer_auth_otps SET invalidated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [otpId]
    ).catch(() => {});
    console.error("Customer OTP delivery failed:", {
      message: error?.message || String(error),
      code: error?.code || null,
      status: error?.statusCode || null,
      interakt: error?.safeInteraktError || null,
      // Configuration booleans only; never log the API key or OTP.
      config: {
        ...getInteraktConfigurationStatus(),
        ...getInteraktOtpConfigurationStatus(),
      },
    });
    return res.status(502).json({
      success: false,
      message: "Unable to send WhatsApp OTP. Please try again later.",
    });
  }
}

/** GET /api/customer/auth/interakt-status (admin only via router) */
export async function getCustomerOtpProviderStatus(req, res) {
  return res.status(200).json({
    success: true,
    interakt: {
      ...getInteraktConfigurationStatus(),
      ...getInteraktOtpConfigurationStatus(),
      customerAuth: getCustomerAuthConfigurationStatus(),
    },
  });
}

/** POST /api/customer/auth/verify-otp */
export async function verifyCustomerOtp(req, res) {
  if (!isSecureRequest(req)) {
    return res.status(400).json({ success: false, message: "HTTPS is required" });
  }
  const validated = validatePhone(req.body);
  const otp = typeof req.body?.otp === "string" ? req.body.otp.trim() : "";
  if (validated.error || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ success: false, message: "Invalid phone or OTP" });
  }

  const phone = validated.phone;
  const client = await pool.connect();
  const lockName = `customer_otp:${phone}`;
  try {
    await client.query("BEGIN");
    const lock = await client.query("SELECT GET_LOCK(?, 10) AS locked", [lockName]);
    if (!lock.rows[0]?.locked) {
      await client.query("ROLLBACK");
      return res.status(503).json({ success: false, message: "Unable to verify OTP" });
    }
    const found = await client.query(
      `SELECT id, otp_hash, expires_at, attempts,
              (expires_at > CURRENT_TIMESTAMP) AS is_valid
       FROM customer_auth_otps
       WHERE phone = ? AND verified_at IS NULL AND invalidated_at IS NULL
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [phone]
    );
    if (!found.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "OTP is invalid or expired" });
    }
    const record = found.rows[0];
    if (!record.is_valid) {
      await client.query(
        "UPDATE customer_auth_otps SET invalidated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [record.id]
      );
      await client.query("COMMIT");
      return res.status(400).json({ success: false, message: "OTP is invalid or expired" });
    }
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await client.query("ROLLBACK");
      return res.status(429).json({ success: false, message: "Too many OTP attempts" });
    }
    if (!verifyOtpHash(phone, otp, record.otp_hash)) {
      const nextAttempts = Number(record.attempts) + 1;
      await client.query(
        `UPDATE customer_auth_otps
         SET attempts = ?,
             invalidated_at = CASE
               WHEN ? >= ? THEN CURRENT_TIMESTAMP
               ELSE invalidated_at END
         WHERE id = ?`,
        [nextAttempts, nextAttempts, OTP_MAX_ATTEMPTS, record.id]
      );
      await client.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
      await client.query("COMMIT");
      return res.status(nextAttempts >= OTP_MAX_ATTEMPTS ? 429 : 400).json({
        success: false,
        message: nextAttempts >= OTP_MAX_ATTEMPTS
          ? "Too many OTP attempts. Request a new OTP."
          : "OTP is invalid or expired",
      });
    }

    await client.query(
      `UPDATE customer_auth_otps SET verified_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [record.id]
    );
    await client.query(
      `UPDATE customer_auth_otps SET invalidated_at = CURRENT_TIMESTAMP
       WHERE phone = ? AND id <> ? AND verified_at IS NULL AND invalidated_at IS NULL`,
      [phone, record.id]
    );
    const tokenId = crypto.randomUUID();
    const expiresAt = customerSessionExpiry();
    await client.query(
      `INSERT INTO customer_sessions (token_id, phone, expires_at)
       VALUES (?, ?, ?)`,
      [tokenId, phone, expiresAt]
    );
    await client.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
    await client.query("COMMIT");

    const token = signCustomerToken({ phone, tokenId });
    const profile = await loadProfile(phone);
    return res.status(200).json({
      success: true,
      token,
      expires_at: expiresAt,
      customer: profile,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Customer OTP verification error:", error?.message || error);
    return res.status(500).json({ success: false, message: "Unable to verify OTP" });
  } finally {
    client.release();
  }
}

async function loadProfile(phone) {
  const { rows } = await query(
    `SELECT customer_name, email FROM orders
     WHERE ${PHONE_MATCH_SQL}
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  return {
    phone,
    name: rows[0]?.customer_name || null,
    email: rows[0]?.email || null,
  };
}

export async function logoutCustomer(req, res) {
  await query(
    `UPDATE customer_sessions SET revoked_at = CURRENT_TIMESTAMP
     WHERE token_id = ? AND phone = ? AND revoked_at IS NULL`,
    [req.customer.tokenId, req.customer.phone]
  );
  return res.status(200).json({ success: true, message: "Logged out successfully" });
}

export async function getCustomerProfile(req, res) {
  return res.status(200).json({
    success: true,
    customer: await loadProfile(req.customer.phone),
  });
}

export async function listCustomerOrders(req, res) {
  const { rows } = await query(
    `SELECT ${SAFE_ORDER_COLUMNS} FROM orders
     WHERE ${PHONE_MATCH_SQL}
     ORDER BY created_at DESC, id DESC`,
    [req.customer.phone]
  );
  const shipments = await loadLatestShipmentsMap(rows.map((row) => row.id));
  return res.status(200).json({
    success: true,
    orders: rows.map((row) =>
      safeOrder(row, req, false, shipments.get(Number(row.id)) || null)
    ),
  });
}

export async function getRecentCustomerOrder(req, res) {
  const { rows } = await query(
    `SELECT ${SAFE_ORDER_COLUMNS} FROM orders
     WHERE ${PHONE_MATCH_SQL}
     ORDER BY
       CASE WHEN payment_status = 'Paid' AND order_status NOT IN ('Delivered', 'Cancelled') THEN 0 ELSE 1 END,
       created_at DESC, id DESC
     LIMIT 1`,
    [req.customer.phone]
  );
  if (!rows.length) {
    return res.status(404).json({ success: false, message: "No orders found" });
  }
  const shipment = await loadLatestShipment(rows[0].id);
  return res.status(200).json({
    success: true,
    order: safeOrder(rows[0], req, true, shipment),
  });
}

export async function getCustomerOrder(req, res) {
  const order = await loadOwnedOrder(req.params.orderId, req.customer.phone);
  if (!order) {
    return missingOwnedOrderResponse(req.params.orderId, res);
  }
  const shipment = await loadLatestShipment(order.id);
  return res.status(200).json({
    success: true,
    order: safeOrder(order, req, true, shipment),
  });
}

/** POST /api/customer/orders/:orderId/cancel */
export async function cancelCustomerCodOrder(req, res) {
  const id = Number(req.params.orderId);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }

  const { rowCount: exists } = await query(
    "SELECT 1 FROM orders WHERE id = ? LIMIT 1",
    [id]
  );
  if (!exists) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }

  const owned = await loadOwnedOrder(id, req.customer.phone);
  if (!owned) {
    return res.status(403).json({
      success: false,
      message: "You are not authorized to cancel this order.",
    });
  }

  const client = await pool.connect();
  let inventoryEmails = [];
  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT * FROM orders
       WHERE id = ? AND ${PHONE_MATCH_SQL}
       FOR UPDATE`,
      [id, req.customer.phone]
    );
    const order = locked.rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "You are not authorized to cancel this order.",
      });
    }

    let shipment = null;
    try {
      const shipResult = await client.query(
        `SELECT order_id, waybill_number, shipment_id, shipment_created_at,
                fulfillment_status, shipment_status, pickup_requested_at
         FROM shipments
         WHERE sequence_no = 1 AND order_id = ?
         LIMIT 1
         FOR UPDATE`,
        [id]
      );
      shipment = shipResult.rows[0] || null;
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
    }

    const eligibility = evaluateCustomerCodCancel(order, shipment);
    if (!eligibility.ok) {
      await client.query("ROLLBACK");
      return res.status(eligibility.status).json({
        success: false,
        message: eligibility.message,
      });
    }

    const updated = await client.query(
      `UPDATE orders
       SET order_status = 'Cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND order_status <> 'Cancelled'`,
      [id]
    );
    if (!updated.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "This order has already been cancelled.",
      });
    }

    const restoreResult = await restoreStockForCancellation(client, {
      orderId: order.id,
      orderNumber: order.order_number,
      quantity: order.quantity,
      adminId: null,
    });
    inventoryEmails = restoreResult.pendingEmails || [];

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (inventoryEmails.length) {
    dispatchInventoryAlertEmails(inventoryEmails);
  }

  const { rows } = await query(
    `SELECT ${SAFE_ORDER_COLUMNS} FROM orders WHERE id = ? LIMIT 1`,
    [id]
  );
  const shipment = await loadLatestShipment(id);
  return res.status(200).json({
    success: true,
    message: "Order cancelled successfully",
    order: safeOrder(rows[0], req, true, shipment),
  });
}

export async function trackCustomerOrder(req, res) {
  const order = await loadOwnedOrder(req.params.orderId, req.customer.phone);
  if (!order) {
    return missingOwnedOrderResponse(req.params.orderId, res);
  }

  const awb = order.waybill ? String(order.waybill).trim() : "";
  if (!awb) {
    return res.status(200).json({
      success: true,
      order_number: order.order_number,
      tracking: {
        available: false,
        awb: null,
        waybill: null,
        status: order.shipment_status || "Not Created",
        current_location: null,
        estimated_delivery: null,
        updated_at: order.tracking_updated_at || null,
        tracking_url: null,
        events: [],
      },
    });
  }

  return res.status(200).json({
    success: true,
    order_number: order.order_number,
    tracking: {
      available: true,
      awb,
      waybill: awb,
      status: order.shipment_status || order.tracking_status || "Created",
      current_location: null,
      estimated_delivery: null,
      updated_at: order.shipment_created_at || order.tracking_updated_at || null,
      tracking_url: `https://www.delhivery.com/track/package/${encodeURIComponent(awb)}`,
      events: [],
    },
  });
}
