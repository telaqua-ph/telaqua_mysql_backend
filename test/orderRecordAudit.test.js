import test from 'node:test';
import assert from 'node:assert/strict';
import { auditOrderRecord, auditOrderRecords } from '../services/orderRecordAudit.js';

const cod = {
  id: 378, order_number: 'TAQ-000378', quantity: 1, total_amount: 1799, final_total: 1799,
  payment_status: 'Paid', payment_method: 'cod', payment_mode: 'cod',
  created_at: '2026-08-25T05:18:47Z',
};

test('normal historical paid COD is valid and never inferred to be offline', () => {
  assert.deepEqual(auditOrderRecord(cod), []);
  const row = { ...cod, offline_sold: 'COD Paid-Cash', order_channel: 'admin' };
  assert.deepEqual(auditOrderRecord(row), ['LEGACY_OFFLINE_MARKER_OUTSIDE_OFFLINE_LIST']);
  assert.equal(row.payment_status, 'Paid');
});

test('explicit recent admin cash and QR records are internally consistent', () => {
  for (const offline_sold of ['COD Paid-Cash', 'COD Paid-QR']) {
    assert.deepEqual(auditOrderRecord({ ...cod, created_at: '2026-11-10T10:00:00Z', offline_sold, order_channel: 'admin' }), []);
  }
});

test('advances use captured historical amounts, including the old additional fee', () => {
  for (const advance of [199, 398, 597]) {
    assert.deepEqual(auditOrderRecord({ ...cod, cod_advance_status: 'paid', cod_advance_fee: advance, cod_amount_due: 1799 - advance, cod_advance_razorpay_payment_id: 'pay_1' }), []);
  }
  assert.deepEqual(auditOrderRecord({ ...cod, cod_advance_status: 'paid', cod_advance_fee: 99, cod_amount_due: 1799, cod_advance_razorpay_payment_id: 'pay_old' }), []);
  assert.ok(auditOrderRecord({ ...cod, cod_advance_status: 'paid', cod_advance_fee: 597, cod_amount_due: 1600 }).includes('ADVANCE_AND_BALANCE_DO_NOT_MATCH_TOTAL'));
});

test('all rows are checked; report identifies inconsistencies without changing records', () => {
  const rows = [cod, { ...cod, id: 379, offline_sold: 'COD Paid-QR', payment_status: 'Pending' }];
  const before = structuredClone(rows);
  const report = auditOrderRecords(rows);
  assert.equal(report.orders_checked, 2);
  assert.equal(report.orders_flagged, 1);
  assert.equal(report.flagged_orders[0].id, 379);
  assert.equal(report.findings_by_code.OFFLINE_MARKER_WITHOUT_PAID_STATUS, 1);
  assert.deepEqual(rows, before);
});
