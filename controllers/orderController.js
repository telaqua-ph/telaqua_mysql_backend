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
import { logPaymentEvent, reconcileRazorpayOrder, triggerOrderFulfillmentAsync } from "../services/confirmRazorpayPayment.js";
import {
  assertStockAvailable,
  dispatchInventoryAlertEmails,
  restoreStockForCancellation,
} from "../services/inventoryService.js";
import {
  buildFinancialSnapshot,
  resolveOrderPricing,
} from "../services/orderPricing.js";
import { normalizePromoCode } from "../services/promoService.js";
import { deriveOrderDisplayStatus } from "../services/orderDisplayStatus.js";
import { deriveShipmentStatusDisplay } from "../services/shipmentStatusDisplay.js";
import {
  isCodOrder,
  withNormalizedPaymentMode,
} from "../services/paymentMode.js";
import { isMissingColumnError } from "../lib/dbErrors.js";
import { pool } from "../config/db.js";
import crypto from "node:crypto";

const ALLOWED_ORDER_STATUSES = [
  "New",
  "Confirmed",
  "Processing",
  "Shipped",
  "Delivered",
  "Cancelled",
];

const ALLOWED_PAYMENT_STATUSES = ["Pending", "Paid", "Failed", "Refunded"];

function createInvoiceAccessToken() {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, hash };
}

async function attachLatestShipments(orders) {
  if (!orders.length) return orders;
  try {
    const ids = orders.map((order) => Number(order.id)).filter(Number.isInteger);
    if (!ids.length) return orders;
    const placeholders = ids.map(() => "?").join(",");
    const { rows } = await query(
      `SELECT * FROM shipments WHERE sequence_no=1 AND order_id IN (${placeholders})`,
      ids
    );
    const byOrder = new Map(rows.map((shipment) => [Number(shipment.order_id), shipment]));
    return orders.map((order) => {
      const shipment = byOrder.get(Number(order.id));
      if (!shipment) return order;
      return {
        ...order,
        shipment_record_id: shipment.id,
        fulfillment_status: shipment.fulfillment_status || order.fulfillment_status,
        waybill: shipment.waybill_number || order.waybill,
        delhivery_shipment_id: shipment.shipment_id || order.delhivery_shipment_id,
        shipment_status: shipment.shipment_status || order.shipment_status,
        shipment_status_code: shipment.shipment_status_code,
        tracking_status_at: shipment.shipment_status_at,
        shipment_created_at: shipment.shipment_created_at || order.shipment_created_at,
        serviceable: shipment.serviceable,
        serviceability_message: shipment.serviceability_message,
        serviceability_checked_at: shipment.serviceability_checked_at,
        pickup_status: shipment.pickup_status || (shipment.pickup_requested_at ? "Requested" : order.pickup_status),
        pickup_requested_at: shipment.pickup_requested_at || order.pickup_requested_at,
        pickup_date: shipment.pickup_date,
        pickup_location: shipment.pickup_location,
        pickup_reference: shipment.pickup_reference,
        tracking_status: shipment.shipment_status || order.tracking_status,
        tracking_updated_at: shipment.last_tracking_update || order.tracking_updated_at,
        tracking_location: shipment.current_location,
        expected_delivery_date: shipment.expected_delivery_date,
        estimated_tat: shipment.estimated_tat,
        tat_checked_at: shipment.tat_checked_at,
        shipping_charge: shipment.shipping_charge,
        rate_calculated_at: shipment.rate_calculated_at,
        label_data: shipment.shipping_label_url || order.label_data,
        label_status: shipment.label_status,
        label_generated_at: shipment.label_generated_at,
        ndr_status: shipment.ndr_status,
        ndr_reason: shipment.ndr_reason,
        shipment_error: shipment.last_error || order.shipment_error,
        shipment_error_at: shipment.last_error_at,
      };
    });
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") return orders;
    throw error;
  }
}

function trimStr(value) {
  return typeof value === "string" ? value.trim() : value;
}

function withDisplayStatuses(order) {
  const normalized = withNormalizedPaymentMode(order);
  return {
    ...normalized,
    display_status: deriveOrderDisplayStatus(normalized),
    shipment_status_display: deriveShipmentStatusDisplay(normalized),
    shipment_status_updated_at:
      normalized.tracking_status_at ||
      normalized.tracking_updated_at ||
      normalized.shipment_created_at ||
      null,
  };
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

function validateManualCodOrder(body) {
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
  if (!city) {
    return { error: "city is required" };
  }
  if (!state) {
    return { error: "state is required" };
  }
  if (!pincode) {
    return { error: "pincode is required" };
  }
  if (!/^\d{6}$/.test(String(pincode))) {
    return { error: "pincode must be a valid 6-digit Indian pincode" };
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
      city,
      state,
      pincode: String(pincode),
      quantity,
      unit_price,
      total_amount,
    },
  };
}

/** Website COD: same shipping/qty rules as Razorpay create-order. Never trust client prices. */
function validateWebsiteCodOrder(body) {
  if (!body || typeof body !== "object") {
    return { error: "Invalid JSON body" };
  }

  const customer_name = trimStr(body.customer_name);
  const phone = String(trimStr(body.phone) || "").replace(/\D/g, "");
  const emailRaw = trimStr(body.email);
  const address = trimStr(body.address);
  const city = trimStr(body.city);
  const state = trimStr(body.state);
  const pincode = String(trimStr(body.pincode) || "").replace(/\D/g, "");
  const quantity = Number(body.quantity);

  const promoRaw =
    body.promo_code !== undefined &&
    body.promo_code !== null &&
    body.promo_code !== ""
      ? body.promo_code
      : body.coupon_code !== undefined &&
          body.coupon_code !== null &&
          body.coupon_code !== ""
        ? body.coupon_code
        : null;
  const promo_code = promoRaw ? normalizePromoCode(promoRaw) : null;

  if (!customer_name) {
    return { error: "customer_name is required" };
  }
  if (!phone) {
    return { error: "phone is required" };
  }
  if (!/^\d{10}$/.test(phone)) {
    return { error: "phone must contain exactly 10 digits" };
  }
  if (!address) {
    return { error: "address is required" };
  }
  if (!city) {
    return { error: "city is required" };
  }
  if (!state) {
    return { error: "state is required" };
  }
  if (!pincode) {
    return { error: "pincode is required" };
  }
  if (!/^\d{6}$/.test(pincode)) {
    return { error: "pincode must contain exactly 6 digits" };
  }
  if (body.quantity === undefined || body.quantity === null || body.quantity === "") {
    return { error: "quantity is required" };
  }
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
    return { error: "quantity must be an integer greater than 0" };
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
    email = String(emailRaw).toLowerCase();
  }

  return {
    data: {
      customer_name,
      phone,
      email,
      address,
      city,
      state,
      pincode,
      quantity,
      promo_code,
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

/** GET /api/orders — latest 2000 rows (stable sort). Dashboard cards use /api/dashboard/stats. */
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
         ORDER BY o.created_at DESC, o.id DESC
         LIMIT 2000`,
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
           ORDER BY o.created_at DESC, o.id DESC
           LIMIT 2000`
        );
        rows = fallback.rows;
      } else {
        throw joinError;
      }
    }

    rows = await attachLatestShipments(rows);
    rows = rows.map(withDisplayStatuses);
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

/** POST /api/orders/manual-cod — admin-only COD order. Does not touch public POST /api/orders. */
export async function createManualCodOrder(req, res) {
  const adminId = currentAdminId(req);
  if (!adminId) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  try {
    const validation = validateManualCodOrder(req.body);
    if (validation.error) {
      return res.status(400).json({
        success: false,
        message: validation.error,
      });
    }

    const orderData = validation.data;

    let inserted;
    try {
      inserted = await query(
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
          payment_mode,
          whatsapp_updates_consent,
          whatsapp_consent_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cod', 'Pending', 'Confirmed', 'cod', 0, NULL
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
        ]
      );
    } catch (error) {
      if (isMissingColumnError(error, "payment_mode")) {
        return res.status(503).json({
          success: false,
          message: "Orders table is missing payment_mode. Run node scripts/migrate-payment-mode.js",
        });
      }
      throw error;
    }

    const id = inserted.insertId;
    const orderNumber = `TAQ-${String(id).padStart(6, "0")}`;

    await query(
      `UPDATE orders
       SET order_number = ?
       WHERE id = ?`,
      [orderNumber, id]
    );

    const { rows } = await query(`SELECT * FROM orders WHERE id = ?`, [id]);

    triggerOrderFulfillmentAsync(id);

    return res.status(201).json({
      success: true,
      message: "COD order created successfully",
      order: withDisplayStatuses(rows[0]),
    });
  } catch (error) {
    console.error("Manual COD order API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** POST /api/orders/website-cod — public storefront COD. Does not touch Razorpay. */
export async function createWebsiteCodOrder(req, res) {
  try {
    const body = req.body;
    if (body == null || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        message: "Invalid JSON body",
      });
    }

    const validation = validateWebsiteCodOrder(body);
    if (validation.error) {
      return res.status(400).json({
        success: false,
        message: validation.error,
      });
    }

    const orderData = validation.data;
    const pricing = await resolveOrderPricing(orderData);
    if (pricing.error) {
      return res.status(400).json({
        success: false,
        message: pricing.error,
      });
    }

    const stockCheck = await assertStockAvailable(orderData.quantity);
    if (!stockCheck.ok) {
      return res.status(409).json({
        success: false,
        message: stockCheck.message,
        available: stockCheck.available,
      });
    }

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

    const financial = buildFinancialSnapshot(pricing);

    let duplicates = [];
    try {
      const dupResult = await query(
        `SELECT id
         FROM orders
         WHERE phone = ?
           AND total_amount = ?
           AND payment_mode = 'cod'
           AND created_at >= DATE_SUB(NOW(), INTERVAL 2 MINUTE)
         LIMIT 1`,
        [orderData.phone, financial.finalTotal]
      );
      duplicates = dupResult.rows;
    } catch (error) {
      if (isMissingColumnError(error, "payment_mode")) {
        return res.status(503).json({
          success: false,
          message:
            "Orders table is missing payment_mode. Run node scripts/migrate-payment-mode.js",
        });
      }
      throw error;
    }
    if (duplicates.length > 0) {
      return res.status(409).json({
        success: false,
        message:
          "Duplicate order detected. Please wait before placing another order.",
      });
    }

    let inserted;
    try {
      inserted = await query(
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
          payment_mode,
          promo_code,
          original_amount,
          discount_amount,
          subtotal,
          taxable_amount,
          gst_amount,
          gst_rate,
          shipping_amount,
          final_total,
          invoice_status,
          whatsapp_updates_consent,
          whatsapp_consent_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'cod', 'Pending', 'Confirmed', 'cod',
          ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'not_created', ?, ?
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
          pricing.unit_price,
          financial.finalTotal,
          pricing.promo_code,
          pricing.original_amount,
          pricing.discount_amount,
          financial.subtotal,
          financial.taxableAmount,
          financial.gstAmount,
          financial.gstRate,
          financial.shippingAmount,
          financial.finalTotal,
          orderData.whatsapp_updates_consent ? 1 : 0,
          orderData.whatsapp_consent_at,
        ]
      );
    } catch (error) {
      const msg = String(error?.message || "");
      if (/Unknown column ['`]?payment_mode['`]?/i.test(msg) || (isMissingColumnError(error, "payment_mode") && /payment_mode/i.test(msg))) {
        return res.status(503).json({
          success: false,
          message:
            "Orders table is missing payment_mode. Run node scripts/migrate-payment-mode.js",
        });
      }
      if (error?.code === "ER_BAD_FIELD_ERROR" || /Unknown column/i.test(msg)) {
        inserted = await query(
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
            payment_mode,
            whatsapp_updates_consent,
            whatsapp_consent_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cod', 'Pending', 'Confirmed', 'cod', ?, ?
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
            pricing.unit_price,
            financial.finalTotal,
            orderData.whatsapp_updates_consent ? 1 : 0,
            orderData.whatsapp_consent_at,
          ]
        );
      } else {
        throw error;
      }
    }

    const id = inserted.insertId;
    const orderNumber = `TAQ-${String(id).padStart(6, "0")}`;
    const invoiceAccess = createInvoiceAccessToken();
    let invoiceAccessToken = null;

    try {
      await query(
        `UPDATE orders
         SET order_number = ?, invoice_access_token_hash = ?
         WHERE id = ?`,
        [orderNumber, invoiceAccess.hash, id]
      );
      invoiceAccessToken = invoiceAccess.token;
    } catch (error) {
      if (isMissingColumnError(error, "invoice_access_token_hash")) {
        await query(
          `UPDATE orders
           SET order_number = ?
           WHERE id = ?`,
          [orderNumber, id]
        );
      } else {
        throw error;
      }
    }

    const { rows } = await query(`SELECT * FROM orders WHERE id = ?`, [id]);

    triggerOrderFulfillmentAsync(id);

    return res.status(201).json({
      success: true,
      message: "COD order placed successfully",
      db_order_id: id,
      order_number: orderNumber,
      payment_mode: "cod",
      payment_status: "Pending",
      total_amount: financial.finalTotal,
      invoice_access_token: invoiceAccessToken,
      order: withDisplayStatuses(rows[0]),
    });
  } catch (error) {
    if (isMissingColumnError(error, "payment_mode")) {
      return res.status(503).json({
        success: false,
        message:
          "Orders table is missing payment_mode. Run node scripts/migrate-payment-mode.js",
      });
    }
    console.error("Website COD order API error:", error);
    return res.status(500).json({
      success: false,
      message: "We could not place your COD order. Please try again.",
    });
  }
}

/** PATCH /api/orders/:id/cod-payment — Pending → Paid for COD only. */
export async function collectCodPayment(req, res) {
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

    const { rows: existing } = await query(
      `SELECT * FROM orders WHERE id = ? LIMIT 1`,
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const order = existing[0];
    if (!isCodOrder(order)) {
      return res.status(409).json({
        success: false,
        message: "COD payment collection is not allowed for Razorpay orders",
      });
    }

    const currentPay = String(order.payment_status || "").trim();
    if (currentPay === "Paid") {
      return res.status(409).json({
        success: false,
        message: "COD payment is already Paid",
      });
    }
    if (currentPay !== "Pending") {
      return res.status(409).json({
        success: false,
        message: "COD payment can only move from Pending to Paid",
      });
    }

    const updated = await query(
      `UPDATE orders
       SET payment_status = 'Paid',
           payment_date = COALESCE(payment_date, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND payment_mode = 'cod'
         AND payment_status = 'Pending'`,
      [id]
    );

    if (!updated.rowCount) {
      return res.status(409).json({
        success: false,
        message: "COD payment could not be updated",
      });
    }

    const { rows } = await query(`SELECT * FROM orders WHERE id = ?`, [id]);
    return res.status(200).json({
      success: true,
      message: "COD payment marked as Paid",
      order: withDisplayStatuses(rows[0]),
    });
  } catch (error) {
    if (isMissingColumnError(error, "payment_mode")) {
      return res.status(503).json({
        success: false,
        message: "Orders table is missing payment_mode. Run node scripts/migrate-payment-mode.js",
      });
    }
    console.error("COD payment API error:", error);
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

    const [withShipment] = await attachLatestShipments(rows);
    const {
      invoice_access_token_hash: _invoiceAccessTokenHash,
      invoice_attempt_token: _invoiceAttemptToken,
      ...safeOrder
    } = withShipment;
    Object.assign(safeOrder, withDisplayStatuses(safeOrder));

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

    let existing;
    try {
      const found = await query(
        `SELECT id, order_status, payment_status, quantity, order_number,
                payment_method, payment_mode
         FROM orders WHERE id = ?`,
        [id]
      );
      existing = found.rows;
    } catch (error) {
      if (!isMissingColumnError(error, "payment_mode")) throw error;
      const found = await query(
        `SELECT id, order_status, payment_status, quantity, order_number,
                payment_method
         FROM orders WHERE id = ?`,
        [id]
      );
      existing = found.rows;
    }

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const prior = existing[0];
    if (
      payment_status !== undefined &&
      String(payment_status).toLowerCase() !==
        String(prior.payment_status || "").toLowerCase()
    ) {
      if (isCodOrder(prior)) {
        return res.status(409).json({
          success: false,
          message:
            "COD payment status can only be updated via PATCH /api/orders/:id/cod-payment",
        });
      }
      return res.status(409).json({
        success: false,
        message: "Razorpay payment status cannot be updated manually",
      });
    }

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
        order: withDisplayStatuses(rows[0]),
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
