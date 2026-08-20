/**
 * controllers/orderController.js
 *
 * Orders business logic — preserved from Vercel serverless handlers.
 * Includes restored DELETE /api/orders/:id.
 */

import { isMissingTableError } from "../lib/dbErrors.js";
import { query } from "../config/db.js";
import {
  ensureWhatsappConsentColumns,
  parseWhatsappConsent,
} from "../services/whatsappConsent.js";
import { logPaymentEvent, reconcileRazorpayOrder } from "../services/confirmRazorpayPayment.js";
import {
  dispatchInventoryAlertEmails,
  restoreStockForCancellation,
} from "../services/inventoryService.js";
import { pool } from "../config/db.js";

const ALLOWED_ORDER_STATUSES = [
  "New",
  "Confirmed",
  "Processing",
  "Shipped",
  "Delivered",
  "Cancelled",
];

const ALLOWED_PAYMENT_STATUSES = ["Pending", "Paid", "Failed", "Refunded"];

function trimStr(value) {
  return typeof value === "string" ? value.trim() : value;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateCreateOrder(body) {
  if (!body || typeof body !== "object") {
    return { error: "Invalid JSON body" };
  }

  const customer_name = trimStr(body.customer_name);
  const phone = trimStr(body.phone);
  const emailRaw = trimStr(body.email);
  const address = trimStr(body.address);
  const city = trimStr(body.city);
  const state = trimStr(body.state);
  const pincode = trimStr(body.pincode);
  const payment_method = trimStr(body.payment_method);

  const quantity = Number(body.quantity);
  const unit_price = Number(body.unit_price);
  const total_amount = Number(body.total_amount);

  if (!customer_name) {
    return { error: "customer_name is required" };
  }
  if (!phone) {
    return { error: "phone is required" };
  }
  if (!/^\d{10}$/.test(String(phone))) {
    return { error: "phone must contain exactly 10 digits" };
  }
  if (!address) {
    return { error: "address is required" };
  }
  if (body.quantity === undefined || body.quantity === null || body.quantity === "") {
    return { error: "quantity is required" };
  }
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
    return { error: "quantity must be an integer greater than 0" };
  }
  if (body.unit_price === undefined || body.unit_price === null || body.unit_price === "") {
    return { error: "unit_price is required" };
  }
  if (!Number.isFinite(unit_price) || unit_price <= 0) {
    return { error: "unit_price must be a positive number" };
  }
  if (body.total_amount === undefined || body.total_amount === null || body.total_amount === "") {
    return { error: "total_amount is required" };
  }
  if (!Number.isFinite(total_amount) || total_amount <= 0) {
    return { error: "total_amount must be a positive number" };
  }
  if (!payment_method) {
    return { error: "payment_method is required" };
  }

  const consent = parseWhatsappConsent(body);
  if (consent.error) {
    return { error: consent.error };
  }

  let email = null;
  if (emailRaw !== undefined && emailRaw !== null && emailRaw !== "") {
    if (!isValidEmail(emailRaw)) {
      return { error: "email must be a valid email address" };
    }
    email = emailRaw;
  }

  return {
    data: {
      customer_name,
      phone: String(phone),
      email,
      address,
      city: city || null,
      state: state || null,
      pincode: pincode || null,
      quantity,
      unit_price,
      total_amount,
      payment_method,
      whatsapp_updates_consent: consent.whatsapp_updates_consent,
      whatsapp_consent_at: consent.whatsapp_consent_at,
    },
  };
}

function parseOrderId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  return id;
}

function currentAdminId(req) {
  const id = Number(req.user?.admin_id ?? req.user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/orders */
export async function listOrders(req, res) {
  const adminId = currentAdminId(req);
  if (!adminId) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  try {
    let rows;
    try {
      const result = await query(
        `SELECT
           o.*,
           (aov.order_id IS NOT NULL) AS is_seen,
           aov.first_viewed_at,
           aov.last_viewed_at
         FROM orders o
         LEFT JOIN admin_order_views aov
           ON aov.order_id = o.id
          AND aov.admin_id = ?
         ORDER BY o.created_at DESC
         LIMIT 100`,
        [adminId]
      );
      rows = result.rows;
    } catch (joinError) {
      if (
        joinError?.code === "ER_NO_SUCH_TABLE" &&
        String(joinError?.message || "").includes("admin_order_views")
      ) {
        const fallback = await query(
          `SELECT
             o.*,
             0 AS is_seen,
             NULL AS first_viewed_at,
             NULL AS last_viewed_at
           FROM orders o
           ORDER BY o.created_at DESC
           LIMIT 100`
        );
        rows = fallback.rows;
      } else {
        throw joinError;
      }
    }

    return res.status(200).json({
      success: true,
      orders: rows,
    });
  } catch (error) {
    logPaymentEvent("ADMIN_ORDER_FETCH_FAILED", {
      message: error?.message,
      code: error?.code,
    });
    console.error("Orders API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** POST /api/orders/:id/mark-seen */
export async function markOrderSeen(req, res) {
  const adminId = currentAdminId(req);
  if (!adminId) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  try {
    const id = parseOrderId(req.params.id);
    if (id === null) {
      return res.status(400).json({
        success: false,
        message: "Invalid order id",
      });
    }

    const { rows: orderRows } = await query(
      `SELECT id FROM orders WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!orderRows.length) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    await query(
      `INSERT INTO admin_order_views (
         admin_id, order_id, first_viewed_at, last_viewed_at
       ) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE last_viewed_at = CURRENT_TIMESTAMP`,
      [adminId, id]
    );

    return res.status(200).json({
      success: true,
      message: "Order marked as seen",
    });
  } catch (error) {
    if (
      error?.code === "ER_NO_SUCH_TABLE" &&
      String(error?.message || "").includes("admin_order_views")
    ) {
      return res.status(503).json({
        success: false,
        message: "Order view tracking table missing. Run sql/add_order_views.sql",
      });
    }
    console.error("Mark order seen API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/**
 * POST /api/orders/reconcile-razorpay
 * Admin: confirm an existing Neon order from Razorpay if payment is captured.
 */
export async function reconcileRazorpayPayment(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const razorpay_order_id = String(body.razorpay_order_id || "").trim();
    const order_id = Number(body.order_id);
    if (!razorpay_order_id && (!Number.isInteger(order_id) || order_id <= 0)) {
      return res.status(400).json({
        success: false,
        message: "Provide razorpay_order_id or order_id",
      });
    }

    const result = await reconcileRazorpayOrder({
      razorpayOrderId: razorpay_order_id || undefined,
      orderId: Number.isInteger(order_id) && order_id > 0 ? order_id : undefined,
    });

    if (result.status === "not_found") {
      return res.status(404).json({
        success: false,
        message: "Order not found in Neon for this Razorpay order",
        status: result.status,
      });
    }
    if (result.status === "not_captured") {
      return res.status(409).json({
        success: false,
        message: result.message || "Razorpay payment is not captured",
        status: result.status,
      });
    }
    if (result.status === "amount_mismatch") {
      return res.status(409).json({
        success: false,
        message: "Razorpay amount does not match the Neon order",
        status: result.status,
      });
    }
    if (result.status === "ineligible") {
      return res.status(400).json({
        success: false,
        message: result.message || "Order is not eligible for reconciliation",
        status: result.status,
      });
    }

    return res.status(200).json({
      success: true,
      status: result.status,
      order_id: result.order?.id,
      order_number: result.order?.order_number,
      payment_status: result.order?.payment_status || "Paid",
      razorpay_order_id: result.order?.razorpay_order_id,
      razorpay_payment_id: result.order?.razorpay_payment_id,
    });
  } catch (error) {
    logPaymentEvent("WEBHOOK_PROCESSING_FAILED", {
      reason: "reconcile",
      message: error?.message,
    });
    return res.status(500).json({
      success: false,
      message: "Reconciliation failed",
    });
  }
}

/**
 * POST /api/orders/reconcile-pending-razorpay
 * Admin: check recent Pending orders against Razorpay and confirm captured ones.
 */
export async function reconcilePendingRazorpayPayments(req, res) {
  try {
    const minutes = Math.min(Math.max(Number(req.body?.older_than_minutes) || 5, 1), 1440);
    const { rows } = await query(
      `SELECT id, order_number, razorpay_order_id, payment_status
       FROM orders
       WHERE payment_status IN ('Pending', 'Failed')
         AND razorpay_order_id IS NOT NULL
         AND created_at <= DATE_SUB(NOW(), INTERVAL ? MINUTE)
       ORDER BY created_at ASC
       LIMIT 50`,
      [minutes]
    );

    const results = [];
    for (const row of rows) {
      const result = await reconcileRazorpayOrder({
        razorpayOrderId: row.razorpay_order_id,
        orderId: row.id,
      });
      results.push({
        order_id: row.id,
        order_number: row.order_number,
        razorpay_order_id: row.razorpay_order_id,
        status: result.status,
      });
    }

    return res.status(200).json({
      success: true,
      scanned: rows.length,
      results,
    });
  } catch (error) {
    logPaymentEvent("WEBHOOK_PROCESSING_FAILED", {
      reason: "reconcile_pending",
      message: error?.message,
    });
    return res.status(500).json({
      success: false,
      message: "Pending reconciliation failed",
    });
  }
}

/** POST /api/orders */
export async function createOrder(req, res) {
  try {
    const body = req.body;
    if (body == null || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        message: "Invalid JSON body",
      });
    }

    const validation = validateCreateOrder(body);
    if (validation.error) {
      return res.status(400).json({
        success: false,
        message: validation.error,
      });
    }

    const orderData = validation.data;

    try {
      await ensureWhatsappConsentColumns();
    } catch (colErr) {
      console.error("WhatsApp consent columns ensure failed:", colErr?.message);
      return res.status(500).json({
        success: false,
        message:
          "Orders table is missing WhatsApp consent columns. Run sql/add_whatsapp_consent.sql",
      });
    }

    const { rows: duplicates } = await query(
      `SELECT id
       FROM orders
       WHERE phone = ?
         AND total_amount = ?
         AND created_at >= DATE_SUB(NOW(), INTERVAL 2 MINUTE)
       LIMIT 1`,
      [orderData.phone, orderData.total_amount]
    );

    if (duplicates.length > 0) {
      return res.status(409).json({
        success: false,
        message:
          "Duplicate order detected. Please wait before placing another order.",
      });
    }

    const inserted = await query(
      `INSERT INTO orders (
        customer_name,
        phone,
        email,
        address,
        city,
        state,
        pincode,
        quantity,
        unit_price,
        total_amount,
        payment_method,
        payment_status,
        order_status,
        whatsapp_updates_consent,
        whatsapp_consent_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'New', ?, ?
      )`,
      [
        orderData.customer_name,
        orderData.phone,
        orderData.email,
        orderData.address,
        orderData.city,
        orderData.state,
        orderData.pincode,
        orderData.quantity,
        orderData.unit_price,
        orderData.total_amount,
        orderData.payment_method,
        orderData.whatsapp_updates_consent ? 1 : 0,
        orderData.whatsapp_consent_at,
      ]
    );

    const id = inserted.insertId;
    const orderNumber = `TAQ-${String(id).padStart(6, "0")}`;

    await query(
      `UPDATE orders
       SET order_number = ?
       WHERE id = ?`,
      [orderNumber, id]
    );

    const { rows } = await query(`SELECT * FROM orders WHERE id = ?`, [id]);

    return res.status(201).json({
      success: true,
      message: "Order created successfully",
      order: rows[0],
    });
  } catch (error) {
    console.error("Orders API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** GET /api/orders/:id */
export async function getOrderById(req, res) {
  try {
    const id = parseOrderId(req.params.id);
    if (id === null) {
      return res.status(400).json({
        success: false,
        message: "Invalid order id",
      });
    }

    const { rows } = await query(
      `SELECT *
       FROM orders
       WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const {
      invoice_access_token_hash: _invoiceAccessTokenHash,
      invoice_attempt_token: _invoiceAttemptToken,
      ...safeOrder
    } = rows[0];

    return res.status(200).json({
      success: true,
      order: safeOrder,
    });
  } catch (error) {
    console.error("Order by id API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** PUT /api/orders/:id */
export async function updateOrder(req, res) {
  try {
    const id = parseOrderId(req.params.id);
    if (id === null) {
      return res.status(400).json({
        success: false,
        message: "Invalid order id",
      });
    }

    const body = req.body;
    if (body == null || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        message: "Invalid JSON body",
      });
    }

    const order_status =
      body.order_status !== undefined ? trimStr(body.order_status) : undefined;
    const payment_status =
      body.payment_status !== undefined
        ? trimStr(body.payment_status)
        : undefined;

    if (order_status === undefined && payment_status === undefined) {
      return res.status(400).json({
        success: false,
        message: "Provide order_status and/or payment_status to update",
      });
    }

    if (
      order_status !== undefined &&
      !ALLOWED_ORDER_STATUSES.includes(order_status)
    ) {
      return res.status(400).json({
        success: false,
        message: `Invalid order_status. Allowed values: ${ALLOWED_ORDER_STATUSES.join(", ")}`,
      });
    }

    if (
      payment_status !== undefined &&
      !ALLOWED_PAYMENT_STATUSES.includes(payment_status)
    ) {
      return res.status(400).json({
        success: false,
        message: `Invalid payment_status. Allowed values: ${ALLOWED_PAYMENT_STATUSES.join(", ")}`,
      });
    }

    const { rows: existing } = await query(
      `SELECT id, order_status, payment_status, quantity, order_number
       FROM orders WHERE id = ?`,
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const prior = existing[0];
    const nextOrderStatus = order_status ?? prior.order_status;
    const nextPaymentStatus = payment_status ?? prior.payment_status;
    const isCancelling =
      nextOrderStatus === "Cancelled" && prior.order_status !== "Cancelled";

    const client = await pool.connect();
    let inventoryEmails = [];
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE orders
         SET
           order_status = COALESCE(?, order_status),
           payment_status = COALESCE(?, payment_status),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [order_status ?? null, payment_status ?? null, id]
      );

      const { rows } = await client.query(`SELECT * FROM orders WHERE id = ?`, [id]);

      if (
        isCancelling &&
        (prior.payment_status === "Paid" || nextPaymentStatus === "Paid")
      ) {
        const restoreResult = await restoreStockForCancellation(client, {
          orderId: prior.id,
          orderNumber: prior.order_number,
          quantity: prior.quantity,
          adminId: Number(req.user?.admin_id) || null,
        });
        inventoryEmails = restoreResult.pendingEmails || [];
      }

      await client.query("COMMIT");

      if (inventoryEmails.length) {
        dispatchInventoryAlertEmails(inventoryEmails);
      }

      return res.status(200).json({
        success: true,
        message: "Order updated successfully",
        order: rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Order by id API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** DELETE /api/orders/:id — restored */
export async function deleteOrder(req, res) {
  try {
    const id = parseOrderId(req.params.id);
    if (id === null) {
      return res.status(400).json({
        success: false,
        message: "Invalid order id",
      });
    }

    const { rowCount } = await query(
      `DELETE FROM orders
       WHERE id = ?`,
      [id]
    );

    if (!rowCount) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Order deleted successfully",
    });
  } catch (error) {
    console.error("Order by id API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}
