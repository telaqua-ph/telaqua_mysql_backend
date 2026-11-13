const text = (value) => String(value || '').trim().toLowerCase();
const hasValue = (value) => value !== null && value !== undefined && value !== '';
const sameMoney = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;
const offlineTypes = new Set(['cod paid-cash', 'cod paid-qr']);
const offlineSectionStarted = Date.parse('2026-11-07T08:23:00.000Z');

/** Read-only checks. Findings require review; they never authorize a data repair. */
export function auditOrderRecord(order) {
  const findings = [];
  const add = (code) => findings.push(code);
  const mode = text(order.payment_mode);
  const method = text(order.payment_method);
  const status = text(order.payment_status);
  const offline = text(order.offline_sold);
  const total = Number(order.final_total ?? order.total_amount);

  if (!hasValue(order.quantity) || !Number.isInteger(Number(order.quantity)) || Number(order.quantity) <= 0) add('INVALID_QUANTITY');
  if (!hasValue(order.final_total ?? order.total_amount) || !Number.isFinite(total) || total < 0) add('INVALID_TOTAL');
  if (hasValue(order.final_total) && hasValue(order.total_amount) && !sameMoney(order.final_total, order.total_amount)) add('TOTAL_FIELDS_DIFFER');
  if ((mode === 'razorpay' && method === 'cod') || (mode === 'cod' && method === 'razorpay')) add('PAYMENT_MODE_METHOD_CONFLICT');

  if (offline) {
    if (!offlineTypes.has(offline)) add('UNKNOWN_OR_LEGACY_OFFLINE_TYPE');
    if (status !== 'paid') add('OFFLINE_MARKER_WITHOUT_PAID_STATUS');
    if ((mode && mode !== 'cod') || (!mode && method !== 'cod')) add('OFFLINE_MARKER_WITH_NON_COD_PAYMENT');
    if (text(order.order_channel) !== 'admin') add('OFFLINE_MARKER_WITHOUT_ADMIN_SOURCE');
    const created = Date.parse(order.created_at);
    if (!Number.isFinite(created)) add('OFFLINE_MARKER_WITHOUT_ENTRY_DATE');
    else if (created < offlineSectionStarted) add('LEGACY_OFFLINE_MARKER_OUTSIDE_OFFLINE_LIST');
    if (order.cod_advance_razorpay_payment_id) add('OFFLINE_MARKER_WITH_WEBSITE_COD_ADVANCE');
  }

  if (text(order.cod_advance_status) === 'paid') {
    const advance = Number(order.cod_advance_fee);
    const due = Number(order.cod_amount_due);
    if (!Number.isFinite(advance) || advance <= 0) add('INVALID_PAID_ADVANCE');
    if (!hasValue(order.cod_amount_due) || !Number.isFinite(due) || due < 0) add('INVALID_COD_BALANCE');
    else if (sameMoney(due, total) && sameMoney(advance, 99)) {
      // Legacy ₹99 fee was additional; preserve this historical payment model.
    } else if (!sameMoney(advance + due, total)) add('ADVANCE_AND_BALANCE_DO_NOT_MATCH_TOTAL');
    if (!order.cod_advance_razorpay_payment_id) add('PAID_ADVANCE_WITHOUT_PAYMENT_REFERENCE');
  }
  return findings;
}

export function auditOrderRecords(orders) {
  const findingsByCode = {};
  const flaggedOrders = [];
  for (const order of orders) {
    const findings = auditOrderRecord(order);
    for (const code of findings) findingsByCode[code] = (findingsByCode[code] || 0) + 1;
    if (findings.length) flaggedOrders.push({ id: order.id, order_number: order.order_number, findings });
  }
  return { orders_checked: orders.length, orders_flagged: flaggedOrders.length, findings_by_code: findingsByCode, flagged_orders: flaggedOrders };
}
