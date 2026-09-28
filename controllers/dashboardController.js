/**
 * Dashboard operations + sales metrics.
 * Admin-only aggregated operational and sales stats.
 */

import { query } from "../config/db.js";

function emptyAnalysis(from = null, to = null) {
  return {
    from,
    to,
    devicesSold: 0,
    revenueReceived: 0,
    pendingRevenue: 0,
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
    cancelledOrders: Number(row.cancelled_orders || 0),
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
      pendingRevenue: Number(row.analysis_pending_revenue || 0),
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

/** Mirrors services/orderDisplayStatus.js for SQL-side dashboard aggregates. */
function confirmedOrderPredicate(columns, alias = "") {
  if (!columns.has("order_status")) return "FALSE";
  const prefix = alias ? `${alias}.` : "";
  return `LOWER(TRIM(COALESCE(${prefix}order_status, ''))) IN (
    'confirmed', 'processing', 'ready to ship', 'ready_to_ship',
    'ready to pickup', 'ready_to_pickup', 'shipped', 'in transit',
    'in_transit', 'out for delivery', 'out_for_delivery', 'delivered',
    'completed', 'fulfilled'
  )`;
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

function createdDateExpression(columns, alias = "") {
  return columns.has("created_at") ? `${alias ? `${alias}.` : ""}created_at` : "NULL";
}

/**
 * Converts an ISO calendar-date parameter (interpreted as Asia/Kolkata) to
 * the MySQL session timestamp used by order/payment columns. This avoids a
 * UTC session moving an IST date boundary by five and a half hours.
 */
function istDateParameterStartExpression(parameter = "?") {
  return `TIMESTAMPADD(SECOND,
    TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()),
    DATE_SUB(CAST(${parameter} AS DATE), INTERVAL 330 MINUTE))`;
}

async function fetchDashboardStats({ adminId, from, to }) {
  const columns = await readOrdersColumns();
  const includeViews = await hasAdminOrderViewsTable();
  const includeShipmentsTable = await hasShipmentsTable();
  const analysisParams = [
    from, from, to, to,
    from, from, to, to,
    from, from, to, to,
  ];
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
  const createdDateExpr = createdDateExpression(columns);
  // IST midnight, expressed in the same session time as CURRENT_TIMESTAMP payments.
  // Numeric offsets also work when MySQL timezone tables are not installed.
  const todayStartExpr = `TIMESTAMPADD(SECOND,
    TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()),
    DATE_SUB(DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 330 MINUTE)), INTERVAL 330 MINUTE))`;
  // Calculate the month from the IST calendar date before translating it back
  // to the session timezone. Deriving DAYOFMONTH from todayStartExpr is wrong
  // in a UTC session because that instant is still the prior UTC date.
  const monthStartExpr = `TIMESTAMPADD(SECOND,
    TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()),
    DATE_SUB(
      DATE_SUB(
        DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 330 MINUTE)),
        INTERVAL (DAYOFMONTH(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 330 MINUTE)) - 1) DAY
      ),
      INTERVAL 330 MINUTE
    ))`;
  const shipmentExpr = shipmentPredicate(columns, "", includeShipmentsTable);
  const codExpr = codOrderPredicate(columns);
  const confirmedOrderExpr = confirmedOrderPredicate(columns);
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
     /* Full-table operations counts (no date filter, no LIMIT). Paid = payment_status Paid only. */
     operational AS (
       SELECT
         CAST(COUNT(*) AS SIGNED) AS total_orders,
         CAST(SUM(CASE WHEN LOWER(${orderStatusExpr}) IN ('new', 'pending') THEN 1 ELSE 0 END) AS SIGNED) AS new_orders,
         CAST(SUM(CASE WHEN ${paymentStatusExpr} = 'Paid' THEN 1 ELSE 0 END) AS SIGNED) AS paid_orders,
         CAST(SUM(CASE WHEN ${paymentStatusExpr} = 'Pending' THEN 1 ELSE 0 END) AS SIGNED) AS pending_payments,
         CAST(SUM(CASE WHEN ${codExpr} THEN 1 ELSE 0 END) AS SIGNED) AS cod_orders,
         CAST(SUM(CASE WHEN ${shipmentExpr} THEN 1 ELSE 0 END) AS SIGNED) AS shipments_created,
         CAST(SUM(CASE WHEN LOWER(${orderStatusExpr}) = 'cancelled' THEN 1 ELSE 0 END) AS SIGNED) AS cancelled_orders,
         CAST(SUM(CASE WHEN ${unseenPredicate} THEN 1 ELSE 0 END) AS SIGNED) AS unseen_orders
       FROM order_rows o
     ),
     /*
      * Device quantities and revenue deliberately have different eligibility
      * rules. A confirmed COD order is a sale for device-count purposes from
      * its creation date, even before collection. Revenue remains payment
      * confirmed only. Each CTE starts from one order row, so an order can
      * never be counted twice when its payment or status later changes.
      */
     device_orders AS (
       SELECT *,
         CASE WHEN ${codExpr} THEN ${createdDateExpr} ELSE ${paidDateExpr} END AS device_counted_at
       FROM orders
       WHERE (
         (${codExpr} AND ${confirmedOrderExpr})
         OR (
           NOT (${codExpr})
           AND ${paymentStatusExpr} = 'Paid'
           AND LOWER(${orderStatusExpr}) <> 'cancelled'
         )
       )
       ${paidTestFilter}
     ),
     paid_orders AS (
       SELECT *, ${paidDateExpr} AS paid_at
       FROM orders
       WHERE ${paymentStatusExpr} = 'Paid'
         AND LOWER(${orderStatusExpr}) <> 'cancelled'
         ${paidTestFilter}
     ),
     pending_cod_orders AS (
       SELECT *, ${createdDateExpr} AS pending_at
       FROM orders
       WHERE ${codExpr}
         AND ${confirmedOrderExpr}
         AND ${paymentStatusExpr} = 'Pending'
         ${paidTestFilter}
     ),
    sales AS (
      SELECT
         CAST(COALESCE((SELECT SUM(${quantityExpr}) FROM device_orders), 0) AS SIGNED) AS devices_sold,
         CAST(COALESCE((SELECT SUM(${revenueExpr}) FROM paid_orders), 0) AS DECIMAL(12,2)) AS revenue_received,
         CAST(COALESCE(
           (SELECT SUM(CASE
             WHEN device_counted_at IS NOT NULL
               AND device_counted_at >= ${todayStartExpr}
               AND device_counted_at < DATE_ADD(${todayStartExpr}, INTERVAL 1 DAY)
             THEN ${quantityExpr} ELSE 0 END)
            FROM device_orders),
           0) AS SIGNED) AS today_devices_sold,
         CAST(COALESCE(
           (SELECT SUM(CASE
             WHEN paid_at IS NOT NULL
               AND paid_at >= ${todayStartExpr}
               AND paid_at < DATE_ADD(${todayStartExpr}, INTERVAL 1 DAY)
             THEN ${revenueExpr} ELSE 0 END)
            FROM paid_orders),
           0) AS DECIMAL(12,2)) AS today_revenue,
         CAST(COALESCE(
           (SELECT SUM(CASE
             WHEN device_counted_at IS NOT NULL
               AND device_counted_at >= ${monthStartExpr}
               AND device_counted_at < DATE_ADD(${monthStartExpr}, INTERVAL 1 MONTH)
             THEN ${quantityExpr} ELSE 0 END)
            FROM device_orders),
           0) AS SIGNED) AS month_devices_sold,
         CAST(COALESCE(
           (SELECT SUM(CASE
             WHEN paid_at IS NOT NULL
               AND paid_at >= ${monthStartExpr}
               AND paid_at < DATE_ADD(${monthStartExpr}, INTERVAL 1 MONTH)
             THEN ${revenueExpr} ELSE 0 END)
            FROM paid_orders),
           0) AS DECIMAL(12,2)) AS month_revenue
     ),
     analysis AS (
       SELECT
         /* These three summaries share their contributing CTEs with the
          * preset tiles; only the same explicit IST date range changes. */
         CAST(COALESCE((
           SELECT SUM(${quantityExpr})
           FROM device_orders
           WHERE (? IS NULL OR device_counted_at >= ${istDateParameterStartExpression("?")})
             AND (? IS NULL OR device_counted_at < DATE_ADD(${istDateParameterStartExpression("?")}, INTERVAL 1 DAY))
         ), 0) AS SIGNED) AS analysis_devices_sold,
         CAST(COALESCE((
           SELECT SUM(${revenueExpr})
           FROM paid_orders
           WHERE (? IS NULL OR paid_at >= ${istDateParameterStartExpression("?")})
             AND (? IS NULL OR paid_at < DATE_ADD(${istDateParameterStartExpression("?")}, INTERVAL 1 DAY))
         ), 0) AS DECIMAL(12,2)) AS analysis_revenue_received,
         CAST(COALESCE((
           SELECT SUM(${revenueExpr})
           FROM pending_cod_orders
           WHERE (? IS NULL OR pending_at >= ${istDateParameterStartExpression("?")})
             AND (? IS NULL OR pending_at < DATE_ADD(${istDateParameterStartExpression("?")}, INTERVAL 1 DAY))
         ), 0) AS DECIMAL(12,2)) AS analysis_pending_revenue
     )
     SELECT
       operational.*,
       sales.*,
       analysis.analysis_devices_sold,
       analysis.analysis_revenue_received,
       analysis.analysis_pending_revenue
     FROM operational
     CROSS JOIN sales
     CROSS JOIN analysis`,
    includeViews ? [adminId, ...analysisParams] : analysisParams
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
        cancelledOrders: 0,
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
