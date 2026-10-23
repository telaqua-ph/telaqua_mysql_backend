/**
 * services/couponUsageService.js
 *
 * Unique customers who successfully placed an order with each coupon code.
 * Read-only. promo_codes.used_count is NOT changed here; it still drives
 * usage_limit enforcement at checkout.
 *
 * An order counts only when ALL of these hold (same definitions the
 * dashboard uses for sales):
 *  - orders.promo_code is set (the code actually stored on the order)
 *  - COD:      order confirmation status is Confirmed (or later), payment may
 *              still be Pending (deviceConfirmationPredicate)
 *    Razorpay: payment_status = Paid
 *  - not cancelled (order flags/status, shipment cancellation, inventory
 *    CANCELLATION record)  — cancellationPredicate
 *  - not RTO / returned (order or shipment status)
 *  - not a test order (is_test_order = 0)
 *  - deleted orders are excluded automatically: they are moved out of
 *    `orders` into `deleted_orders` when deleted.
 *
 * Customers are identified by normalized 10-digit phone, falling back to
 * lower-cased email. Names are never used. Each customer counts once per code.
 */

import { query } from "../config/db.js";
import { normalizePromoCode } from "./promoService.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";
import {
  cancellationPredicate,
  codOrderPredicate,
  deviceConfirmationPredicate,
  hasInventoryHistoryTable,
  hasShipmentsTable,
  readOrdersColumns,
} from "../controllers/dashboardController.js";

const RTO_STATUSES = "'rto', 'returned'";
const RTO_TEXT_REGEX = "'(^|[^a-z])rto([^a-z]|$)|return'";

function rtoPredicate(columns, alias, includeShipmentsTable) {
  const prefix = alias ? `${alias}.` : "";
  const signals = [];
  if (columns.has("fulfillment_status")) {
    signals.push(`LOWER(TRIM(COALESCE(${prefix}fulfillment_status, ''))) IN (${RTO_STATUSES})`);
  }
  if (columns.has("shipment_status")) {
    signals.push(`LOWER(COALESCE(${prefix}shipment_status, '')) REGEXP ${RTO_TEXT_REGEX}`);
  }
  if (includeShipmentsTable) {
    // EXISTS (not JOIN) so multiple shipments never duplicate an order.
    signals.push(`EXISTS (
      SELECT 1 FROM shipments rto_shipment
      WHERE rto_shipment.order_id = ${prefix}id
        AND rto_shipment.sequence_no = 1
        AND (
          LOWER(TRIM(COALESCE(rto_shipment.fulfillment_status, ''))) IN (${RTO_STATUSES})
          OR LOWER(COALESCE(rto_shipment.shipment_status, '')) REGEXP ${RTO_TEXT_REGEX}
        )
    )`);
  }
  return signals.length ? `(${signals.join(" OR ")})` : "FALSE";
}

/** Stable customer key: normalized phone, else email. null when neither exists. */
export function customerKey(row) {
  const parsed = normalizeIndianPhone(row?.phone);
  if (!parsed.error) return `phone:${parsed.phoneNumber}`;
  const digits = String(row?.phone ?? "").replace(/\D/g, "");
  if (digits.length >= 7) return `phone:${digits}`;
  const email = String(row?.email ?? "").trim().toLowerCase();
  if (email) return `email:${email}`;
  return null;
}

/**
 * @param {Array<{promo_code: string, phone?: string, email?: string}>} rows eligible order rows
 * @returns {Map<string, number>} normalized code -> unique customers
 */
export function countUniqueCustomersByCoupon(rows) {
  const byCode = new Map();
  for (const row of rows || []) {
    const code = normalizePromoCode(row?.promo_code);
    const key = customerKey(row);
    if (!code || !key) continue;
    if (!byCode.has(code)) byCode.set(code, new Set());
    byCode.get(code).add(key);
  }
  const counts = new Map();
  for (const [code, set] of byCode) counts.set(code, set.size);
  return counts;
}

/** SQL selecting one row per eligible order (no joins → no duplicates). */
export async function buildEligibleCouponOrdersSql() {
  const columns = await readOrdersColumns();
  if (!columns.has("promo_code")) return null;
  const includeShipmentsTable = await hasShipmentsTable();
  const includeInventoryHistory = await hasInventoryHistoryTable();

  const cod = codOrderPredicate(columns, "o");
  const confirmed = deviceConfirmationPredicate(columns, "o");
  const paid = columns.has("payment_status")
    ? "LOWER(TRIM(COALESCE(o.payment_status, ''))) = 'paid'"
    : "FALSE";
  const cancelled = cancellationPredicate(columns, "o", includeInventoryHistory, includeShipmentsTable);
  const rto = rtoPredicate(columns, "o", includeShipmentsTable);
  const notTest = columns.has("is_test_order") ? "AND COALESCE(o.is_test_order, 0) = 0" : "";
  const phone = columns.has("phone") ? "o.phone" : "NULL";
  const email = columns.has("email") ? "o.email" : "NULL";

  return `SELECT o.id, o.promo_code, ${phone} AS phone, ${email} AS email
    FROM orders o
    WHERE TRIM(COALESCE(o.promo_code, '')) <> ''
      AND (
        (${cod} AND ${confirmed})
        OR (NOT (${cod}) AND ${paid})
      )
      AND NOT ${cancelled}
      AND NOT ${rto}
      ${notTest}`;
}

/** @returns {Promise<Map<string, number>>} */
export async function getUniqueSuccessfulCustomersByCoupon() {
  const sql = await buildEligibleCouponOrdersSql();
  if (!sql) return new Map();
  const { rows } = await query(sql);
  return countUniqueCustomersByCoupon(rows);
}
