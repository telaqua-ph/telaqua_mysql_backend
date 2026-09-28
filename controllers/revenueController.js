/**
 * Admin revenue reporting.
 *
 * Revenue is intentionally derived from the immutable order financial snapshot
 * and payment transition timestamp.  It does not infer payment from fulfilment.
 */
import { query } from "../config/db.js";

function dateInput(value) {
  const normalized = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function istStart(parameter = "?") {
  // Translate an Asia/Kolkata calendar date to the timestamp convention used
  // by this MySQL session, including servers configured with a non-UTC session.
  return `TIMESTAMPADD(SECOND,
    TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()),
    DATE_SUB(CAST(${parameter} AS DATE), INTERVAL 330 MINUTE))`;
}

async function orderColumns() {
  const { rows } = await query(
    `SELECT COLUMN_NAME AS column_name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'`
  );
  return new Set(rows.map((row) => row.column_name));
}

function amountExpression(columns) {
  if (columns.has("final_total") && columns.has("total_amount")) {
    return "COALESCE(final_total, total_amount, 0)";
  }
  if (columns.has("final_total")) return "COALESCE(final_total, 0)";
  if (columns.has("total_amount")) return "COALESCE(total_amount, 0)";
  return "0";
}

function paidAtExpression(columns) {
  if (columns.has("payment_date") && columns.has("created_at")) {
    return "COALESCE(payment_date, created_at)";
  }
  if (columns.has("payment_date")) return "payment_date";
  return columns.has("created_at") ? "created_at" : "NULL";
}

function codPredicate(columns) {
  const mode = columns.has("payment_mode");
  const method = columns.has("payment_method");
  if (mode && method) return `(LOWER(TRIM(COALESCE(payment_mode, ''))) = 'cod'
    OR (LOWER(TRIM(COALESCE(payment_mode, ''))) NOT IN ('cod', 'razorpay')
      AND LOWER(TRIM(COALESCE(payment_method, ''))) IN ('cod', 'cash on delivery', 'cash_on_delivery')))`;
  if (mode) return "LOWER(TRIM(COALESCE(payment_mode, ''))) = 'cod'";
  if (method) return "LOWER(TRIM(COALESCE(payment_method, ''))) IN ('cod', 'cash on delivery', 'cash_on_delivery')";
  return "FALSE";
}

function confirmedPredicate(columns) {
  if (!columns.has("order_status")) return "FALSE";
  return `LOWER(TRIM(COALESCE(order_status, ''))) IN (
    'confirmed', 'processing', 'ready to ship', 'ready_to_ship',
    'ready to pickup', 'ready_to_pickup', 'shipped', 'in transit',
    'in_transit', 'out for delivery', 'out_for_delivery', 'delivered',
    'completed', 'fulfilled'
  )`;
}

function istDayExpression(timestamp) {
  return `TIMESTAMPADD(MINUTE, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) + 330, ${timestamp})`;
}

export async function getRevenueReport(req, res) {
  const from = dateInput(req.query.from);
  const to = dateInput(req.query.to);
  if (!from || !to || from > to) {
    return res.status(400).json({ success: false, message: "A valid from and to date are required." });
  }

  try {
    const columns = await orderColumns();
    const amount = amountExpression(columns);
    const paidAt = paidAtExpression(columns);
    const createdAt = columns.has("created_at") ? "created_at" : "NULL";
    const cod = codPredicate(columns);
    const confirmed = confirmedPredicate(columns);
    const testFilter = columns.has("is_test_order") ? "AND COALESCE(is_test_order, 0) = 0" : "";
    const paymentStatus = columns.has("payment_status") ? "COALESCE(payment_status, '')" : "''";
    const orderStatus = columns.has("order_status") ? "COALESCE(order_status, '')" : "''";

    const { rows } = await query(
      `WITH received AS (
        SELECT id, order_number, ${amount} AS amount, ${paidAt} AS accounting_at,
          CASE WHEN ${cod} THEN 'COD' ELSE 'Razorpay' END AS payment_mode,
          ${paymentStatus} AS payment_status, 'received' AS bucket
        FROM orders
        WHERE ${paymentStatus} = 'Paid'
          AND LOWER(${orderStatus}) <> 'cancelled'
          ${testFilter}
      ), pending_cod AS (
        SELECT id, order_number, ${amount} AS amount, ${createdAt} AS accounting_at,
          'COD' AS payment_mode, ${paymentStatus} AS payment_status, 'pending' AS bucket
        FROM orders
        WHERE ${cod} AND ${confirmed} AND ${paymentStatus} = 'Pending'
          ${testFilter}
      ), contributing AS (
        SELECT * FROM received
        WHERE accounting_at >= ${istStart("?")}
          AND accounting_at < DATE_ADD(${istStart("?")}, INTERVAL 1 DAY)
        UNION ALL
        SELECT * FROM pending_cod
        WHERE accounting_at >= ${istStart("?")}
          AND accounting_at < DATE_ADD(${istStart("?")}, INTERVAL 1 DAY)
      )
      SELECT id, order_number, amount, accounting_at, payment_mode, payment_status, bucket,
        DATE_FORMAT(${istDayExpression("accounting_at")}, '%Y-%m-%d') AS accounting_date
      FROM contributing
      ORDER BY accounting_at DESC, id DESC`,
      [from, to, from, to]
    );

    const report = {
      receivedRevenue: 0,
      pendingCodRevenue: 0,
      razorpayRevenue: 0,
      codRevenue: 0,
      daily: {},
      orders: [],
    };
    for (const row of rows) {
      const amountValue = Number(row.amount || 0);
      const item = { ...row, amount: amountValue };
      report.orders.push(item);
      if (row.bucket === "received") {
        report.receivedRevenue += amountValue;
        if (row.payment_mode === "COD") report.codRevenue += amountValue;
        else report.razorpayRevenue += amountValue;
        const day = row.accounting_date;
        report.daily[day] = (report.daily[day] || 0) + amountValue;
      } else {
        report.pendingCodRevenue += amountValue;
      }
    }

    return res.status(200).json({
      success: true,
      from,
      to,
      timezone: "Asia/Kolkata",
      receivedRevenue: report.receivedRevenue,
      pendingCodRevenue: report.pendingCodRevenue,
      razorpayRevenue: report.razorpayRevenue,
      codRevenue: report.codRevenue,
      daily: Object.entries(report.daily).map(([date, amount]) => ({ date, amount })),
      orders: report.orders,
    });
  } catch (error) {
    console.error("Revenue report error:", { message: error?.message, code: error?.code });
    return res.status(500).json({ success: false, message: "Unable to load revenue report." });
  }
}
