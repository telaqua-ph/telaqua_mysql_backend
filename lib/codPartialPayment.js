/**
 * COD partial payment (₹199 paid online at checkout, deducted from the total).
 *
 * The order total (final_total) is the price after any coupon. For a website
 * COD order the customer pays ₹199 of it online first; the rest is collected
 * in cash on delivery:
 *
 *   final_total    = price after coupon (unchanged, used for GST/invoice)
 *   cod_advance_fee = ₹199 partial payment (paid via Razorpay)
 *   cod_amount_due  = final_total − ₹199 (collected by the courier)
 *
 * Older orders used a ₹99 delivery fee charged ON TOP of final_total; those
 * have cod_amount_due = final_total. An order is a partial-payment order when
 * its paid advance was deducted, i.e. cod_amount_due < final_total.
 */

export const COD_PARTIAL_PAYMENT_RUPEES = 199;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** Amount paid online now: ₹199, or the whole total if it is smaller. */
export function codPartialAmount(orderTotal) {
  const total = round2(orderTotal);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(COD_PARTIAL_PAYMENT_RUPEES, total);
}

/** Amounts shown to the customer and stored on the order. */
export function codPartialBreakdown(orderTotal) {
  const total = round2(orderTotal);
  const paidNow = codPartialAmount(total);
  return {
    product_amount: total,
    advance_fee: paidNow,
    partial_payment: paidNow,
    pay_now: paidNow,
    pay_on_delivery: round2(total - paidNow),
    total_order_value: total,
  };
}

/** True when the order's ₹199 partial payment was paid and deducted from its total. */
export function isCodPartialPaidOrder(order) {
  if (String(order?.cod_advance_status || "").trim().toLowerCase() !== "paid") return false;
  const fee = Number(order?.cod_advance_fee);
  const due = order?.cod_amount_due == null ? NaN : Number(order.cod_amount_due);
  const total = Number(order?.final_total ?? order?.total_amount);
  return fee > 0 && Number.isFinite(due) && Number.isFinite(total) && due < total;
}

/** Cash the courier collects for a COD order (the total minus any partial payment). */
export function codCollectableAmount(order) {
  const total = Number(order?.final_total ?? order?.total_amount);
  if (isCodPartialPaidOrder(order)) return round2(Number(order.cod_amount_due));
  return Number.isFinite(total) ? round2(total) : 0;
}

/**
 * SQL: the part of an order's total already counted as a paid advance, so
 * revenue = (final_total − this) + advance never counts the ₹199 twice.
 * Returns "0" when the COD advance columns do not exist.
 */
export function codPartialRevenueAdjustmentSql(columns, alias = "") {
  const p = alias ? `${alias}.` : "";
  if (!columns.has("cod_advance_fee") || !columns.has("cod_advance_status") || !columns.has("cod_amount_due")) {
    return "0";
  }
  const total = columns.has("final_total") && columns.has("total_amount")
    ? `COALESCE(${p}final_total, ${p}total_amount)`
    : columns.has("final_total") ? `${p}final_total` : `${p}total_amount`;
  return `(CASE WHEN LOWER(TRIM(COALESCE(${p}cod_advance_status, ''))) = 'paid'
      AND COALESCE(${p}cod_advance_fee, 0) > 0
      AND ${p}cod_amount_due IS NOT NULL
      AND ${p}cod_amount_due < ${total}
    THEN COALESCE(${p}cod_advance_fee, 0) ELSE 0 END)`;
}
