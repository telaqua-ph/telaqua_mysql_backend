/**
 * Dashboard operations + sales metrics.
 * Admin-only aggregated stats sourced from backend-confirmed paid orders.
 */

import { query } from "../config/db.js";

function emptyAnalysis(from = null, to = null) {
  return {
    from,
    to,
    devicesSold: 0,
    revenueReceived: 0,
    averageRevenuePerDevice: 0,
  };
}

function normalizeDateInput(raw) {
  const value = String(raw || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function parseRange(req) {
  const from = normalizeDateInput(req.query.from);
  const to = normalizeDateInput(req.query.to);
  if (from && to && from > to) {
    return { error: "The from date must be earlier than or equal to the to date." };
  }
  return { from, to };
}

function mapStatsRow(row, from, to) {
  return {
    totalOrders: Number(row.total_orders || 0),
    newOrders: Number(row.new_orders || 0),
    paidOrders: Number(row.paid_orders || 0),
    pendingPayments: Number(row.pending_payments || 0),
    codOrders: Number(row.cod_orders || 0),
    shipmentsCreated: Number(row.shipments_created || 0),
    unseenOrders: Number(row.unseen_orders || 0),
    devicesSold: Number(row.devices_sold || 0),
    revenueReceived: Number(row.revenue_received || 0),
    todayDevicesSold: Number(row.today_devices_sold || 0),
    todayRevenue: Number(row.today_revenue || 0),
    monthDevicesSold: Number(row.month_devices_sold || 0),
    monthRevenue: Number(row.month_revenue || 0),
    analysis: {
      from,
      to,
      devicesSold: Number(row.analysis_devices_sold || 0),
      revenueReceived: Number(row.analysis_revenue_received || 0),
      averageRevenuePerDevice: Number(row.analysis_average_revenue_per_device || 0),
    },
  };
}

async function readOrdersColumns() {
  const { rows } = await query(
    `SELECT COLUMN_NAME AS column_name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders'`
  );
  return new Set(rows.map((row) => row.column_name));
}

async function hasAdminOrderViewsTable() {
  const { rows } = await query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'admin_order_views'`
  );
  return Number(rows[0]?.cnt || 0) > 0;
}

/**
 * Newer orders are fulfilled through the `shipments` table (see
 * sql/add_delhivery_logistics.sql), not the legacy orders.waybill /
 * orders.shipment_status columns. Without this, "Shipments Created"
 * never counts shipments created via the current Fulfillment flow.
 */
async function hasShipmentsTable() {
  const { rows } = await query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'shipments'`
  );
  return Number(rows[0]?.cnt || 0) > 0;
}

function revenueExpression(columns, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const hasFinalTotal = columns.has("final_total");
  const hasTotalAmount = columns.has("total_amount");

  if (hasFinalTotal && hasTotalAmount) {
    return `COALESCE(${prefix}final_total, ${prefix}total_amount)`;
  }
  if (hasFinalTotal) return `${prefix}final_total`;
  if (hasTotalAmount) return `${prefix}total_amount`;
  return "0";
}

function shipmentPredicate(columns, alias = "", includeShipmentsTable = false) {
  const prefix = alias ? `${alias}.` : "";
  const hasWaybill = columns.has("waybill");
  const hasShipmentStatus = columns.has("shipment_status");

  const parts = [];
  if (hasWaybill) {
    parts.push(`COALESCE(NULLIF(TRIM(${prefix}waybill), ''), NULL) IS NOT NULL`);
  }
  if (hasShipmentStatus) {
    parts.push(`LOWER(COALESCE(${prefix}shipment_status, '')) NOT IN ('', 'not created')`);
  }
  // Orders fulfilled via the current shipments-table flow never touch the
  // legacy orders.waybill / orders.shipment_status columns above, so they
  // need to be counted from the shipments table directly.
  if (includeShipmentsTable) {
    parts.push(`shipment_waybill_number IS NOT NULL`);
    parts.push(`LOWER(COALESCE(shipment_fulfillment_status, '')) NOT IN ('', 'unfulfilled')`);
  }

  return parts.length ? parts.join("\n            OR ") : "FALSE";
}

/**
 * Same rule as services/paymentMode.js isCodOrder:
 * payment_mode = cod, or legacy payment_method when mode is not razorpay.
 */
function codOrderPredicate(columns, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const hasMode = columns.has("payment_mode");
  const hasMethod = columns.has("payment_method");

  if (hasMode && hasMethod) {
    return `(
            LOWER(TRIM(COALESCE(${prefix}payment_mode, ''))) = 'cod'
            OR (
              LOWER(TRIM(COALESCE(${prefix}payment_mode, ''))) NOT IN ('cod', 'razorpay')
              AND LOWER(TRIM(COALESCE(${prefix}payment_method, ''))) IN ('cod', 'cash on delivery', 'cash_on_delivery')
            )
          )`;
  }
  if (hasMode) {
    return `LOWER(TRIM(COALESCE(${prefix}payment_mode, ''))) = 'cod'`;
  }
  if (hasMethod) {
    return `LOWER(TRIM(COALESCE(${prefix}payment_method, ''))) IN ('cod', 'cash on delivery', 'cash_on_delivery')`;
  }
  return "FALSE";
}

function paidDateExpression(columns, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  if (columns.has("payment_date") && columns.has("created_at")) {
    return `COALESCE(${prefix}payment_date, ${prefix}created_at)`;
  }
  if (columns.has("payment_date")) return `${prefix}payment_date`;
  if (columns.has("created_at")) return `${prefix}created_at`;
  return "NULL";
}

async function fetchDashboardStats({ adminId, from, to }) {
  const columns = await readOrdersColumns();
  const includeViews = await hasAdminOrderViewsTable();
  const includeShipmentsTable = await hasShipmentsTable();
  const params = [adminId, from, to];
  const unseenJoin = includeViews
    ? `LEFT JOIN admin_order_views aov
         ON aov.order_id = o.id
        AND aov.admin_id = ?`
    : "";
  const shipmentsJoin = includeShipmentsTable
    ? `LEFT JOIN shipments s
         ON s.order_id = o.id
        AND s.sequence_no = 1`
    : "";
  const shipmentsSelect = includeShipmentsTable
    ? "s.waybill_number AS shipment_waybill_number, s.fulfillment_status AS shipment_fulfillment_status,"
    : "";
  const unseenPredicate = includeViews ? "is_seen = 0" : "FALSE";
  const revenueExpr = revenueExpression(columns);
  const paidDateExpr = paidDateExpression(columns);
  const shipmentExpr = shipmentPredicate(columns, "", includeShipmentsTable);
  const codExpr = codOrderPredicate(columns);
  const quantityExpr = columns.has("quantity") ? "quantity" : "0";
  const orderStatusExpr = columns.has("order_status")
    ? "COALESCE(order_status, '')"
    : "''";
  const paymentStatusExpr = columns.has("payment_status")
    ? "COALESCE(payment_status, '')"
    : "''";
  const paidTestFilter = columns.has("is_test_order")
    ? "AND COALESCE(is_test_order, 0) = 0"
    : "";

  const { rows } = await query(
    `WITH order_rows AS (
       SELECT
         o.*,
         ${shipmentsSelect}
         ${includeViews ? "aov.first_viewed_at IS NOT NULL" : "0"} AS is_seen
       FROM orders o
       ${unseenJoin}
       ${shipmentsJoin}
     ),
     operational AS (
       SELECT
         CAST(COUNT(*) AS SIGNED) AS total_orders,
         CAST(SUM(CASE WHEN LOWER(${orderStatusExpr}) IN ('new', 'pending') THEN 1 ELSE 0 END) AS SIGNED) AS new_orders,
         CAST(SUM(CASE WHEN ${paymentStatusExpr} = 'Paid' THEN 1 ELSE 0 END) AS SIGNED) AS paid_orders,
         CAST(SUM(CASE WHEN ${paymentStatusExpr} = 'Pending' THEN 1 ELSE 0 END) AS SIGNED) AS pending_payments,
         CAST(SUM(CASE WHEN ${codExpr} THEN 1 ELSE 0 END) AS SIGNED) AS cod_orders,
         CAST(SUM(CASE WHEN ${shipmentExpr} THEN 1 ELSE 0 END) AS SIGNED) AS shipments_created,
         CAST(SUM(CASE WHEN ${unseenPredicate} THEN 1 ELSE 0 END) AS SIGNED) AS unseen_orders
       FROM order_rows o
     ),
     paid_orders AS (
       SELECT *
       FROM orders
       WHERE ${paymentStatusExpr} = 'Paid'
         AND ${orderStatusExpr} <> 'Cancelled'
         ${paidTestFilter}
     ),
     sales AS (
       SELECT
         CAST(COALESCE(SUM(${quantityExpr}), 0) AS SIGNED) AS devices_sold,
         CAST(COALESCE(SUM(${revenueExpr}), 0) AS DECIMAL(12,2)) AS revenue_received,
         CAST(COALESCE(
           SUM(CASE
             WHEN ${paidDateExpr} IS NOT NULL
               AND ${paidDateExpr} >= CURDATE()
               AND ${paidDateExpr} < DATE_ADD(CURDATE(), INTERVAL 1 DAY)
             THEN ${quantityExpr} ELSE 0 END),
           0) AS SIGNED) AS today_devices_sold,
         CAST(COALESCE(
           SUM(CASE
             WHEN ${paidDateExpr} IS NOT NULL
               AND ${paidDateExpr} >= CURDATE()
               AND ${paidDateExpr} < DATE_ADD(CURDATE(), INTERVAL 1 DAY)
             THEN ${revenueExpr} ELSE 0 END),
           0) AS DECIMAL(12,2)) AS today_revenue,
         CAST(COALESCE(
           SUM(CASE
             WHEN ${paidDateExpr} IS NOT NULL
               AND ${paidDateExpr} >= DATE_FORMAT(NOW(), '%Y-%m-01')
               AND ${paidDateExpr} < DATE_ADD(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 1 MONTH)
             THEN ${quantityExpr} ELSE 0 END),
           0) AS SIGNED) AS month_devices_sold,
         CAST(COALESCE(
           SUM(CASE
             WHEN ${paidDateExpr} IS NOT NULL
               AND ${paidDateExpr} >= DATE_FORMAT(NOW(), '%Y-%m-01')
               AND ${paidDateExpr} < DATE_ADD(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 1 MONTH)
             THEN ${revenueExpr} ELSE 0 END),
           0) AS DECIMAL(12,2)) AS month_revenue
       FROM paid_orders
     ),
     analysis AS (
       SELECT
         CAST(COALESCE(SUM(${quantityExpr}), 0) AS SIGNED) AS analysis_devices_sold,
         CAST(COALESCE(SUM(${revenueExpr}), 0) AS DECIMAL(12,2)) AS analysis_revenue_received
       FROM paid_orders
       WHERE (? IS NULL OR ${paidDateExpr} >= ?)
         AND (? IS NULL OR ${paidDateExpr} < DATE_ADD(?, INTERVAL 1 DAY))
     )
     SELECT
       operational.*,
       sales.*,
       analysis.analysis_devices_sold,
       analysis.analysis_revenue_received,
       CAST(CASE
         WHEN analysis.analysis_devices_sold > 0
           THEN ROUND(analysis.analysis_revenue_received / analysis.analysis_devices_sold, 2)
         ELSE 0
       END AS DECIMAL(12,2)) AS analysis_average_revenue_per_device
     FROM operational
     CROSS JOIN sales
     CROSS JOIN analysis`,
    [adminId, from, from, to, to]
  );

  return rows[0] || null;
}

export async function getStats(req, res) {
  const adminId = Number(req.user?.admin_id || req.user?.id);
  if (!Number.isInteger(adminId) || adminId <= 0) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  const range = parseRange(req);
  if (range.error) {
    return res.status(400).json({
      success: false,
      message: range.error,
    });
  }

  const { from, to } = range;

  try {
    const stats = await fetchDashboardStats({
      adminId,
      from,
      to,
    });

    if (!stats) {
      return res.status(200).json({
        success: true,
        totalOrders: 0,
        newOrders: 0,
        paidOrders: 0,
        pendingPayments: 0,
        codOrders: 0,
        shipmentsCreated: 0,
        unseenOrders: 0,
        devicesSold: 0,
        revenueReceived: 0,
        todayDevicesSold: 0,
        todayRevenue: 0,
        monthDevicesSold: 0,
        monthRevenue: 0,
        analysis: emptyAnalysis(from, to),
      });
    }

    return res.status(200).json({
      success: true,
      ...mapStatsRow(stats, from, to),
    });
  } catch (error) {
    console.error("Dashboard stats error:", {
      message: error?.message,
      code: error?.code,
    });
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}
