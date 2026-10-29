/**
 * Leads = checkouts that never got paid, from the leads start date onward.
 *  - COD: rows in cod_advance_payments without an order (see codAdvanceService).
 *  - Online (Razorpay): orders whose payment is still Pending or Failed.
 * Online leads are real order rows; they are hidden from the admin Orders list
 * and shown on the Leads page instead. Once paid they appear in Orders again.
 * Orders created before the start date are never treated as leads.
 */
import { query } from "../config/db.js";
import { leadsStartEpochSeconds } from "./codAdvanceService.js";

/** SQL predicate (alias "o") for an unpaid online order created on/after the start date. */
export function onlineLeadPredicate(alias = "o") {
  const mode = `LOWER(TRIM(COALESCE(${alias}.payment_mode, '')))`;
  const method = `LOWER(TRIM(COALESCE(${alias}.payment_method, '')))`;
  const isCod = `(${mode} = 'cod' OR (${mode} <> 'razorpay' AND ${method} IN ('cod', 'cash on delivery', 'cash_on_delivery')))`;
  const start = Number(leadsStartEpochSeconds()) || 0;
  return `(NOT ${isCod}
    AND LOWER(TRIM(COALESCE(${alias}.payment_status, ''))) IN ('pending', 'failed')
    AND UNIX_TIMESTAMP(${alias}.created_at) >= ${start})`;
}

/** Unpaid online orders for the Leads page, newest first. */
export async function listOnlineLeadOrders({ limit = 500 } = {}) {
  const { rows } = await query(
    `SELECT o.id, o.order_number, o.customer_name, o.phone, o.email, o.address, o.city,
            o.state, o.pincode, o.quantity, o.total_amount, o.final_total, o.promo_code,
            o.payment_status, o.payment_method, o.payment_mode, o.created_at, o.updated_at
     FROM orders o
     WHERE ${onlineLeadPredicate("o")}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ?`,
    [Number(limit) || 500]
  );
  return rows;
}
