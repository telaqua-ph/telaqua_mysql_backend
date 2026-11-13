/** Run with production DB environment: node scripts/audit-order-records.js
 * SELECT-only audit in a read-only transaction. Output excludes customer data.
 * A clean report checks internal consistency, not external payment settlement.
 */
import 'dotenv/config';
import { pool, isDatabaseConfigured } from '../config/db.js';
import { auditOrderRecords } from '../services/orderRecordAudit.js';

let client;
try {
  if (!isDatabaseConfigured()) throw new Error('Database is not configured. Set DB_HOST, DB_NAME, DB_USER and DB_PASSWORD to audit live orders.');
  client = await pool.connect();
  await client.query('START TRANSACTION READ ONLY');
  const { rows: schema } = await client.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'"
  );
  const columns = new Set(schema.map((row) => row.COLUMN_NAME ?? row.column_name));
  const requested = [
    'id', 'order_number', 'quantity', 'total_amount', 'final_total', 'payment_status',
    'payment_method', 'payment_mode', 'offline_sold', 'order_channel', 'created_at',
    'cod_advance_status', 'cod_advance_fee', 'cod_amount_due', 'cod_advance_razorpay_payment_id',
  ];
  const selected = requested.filter((name) => columns.has(name));
  if (!columns.has('id')) throw new Error('Orders schema is unavailable.');
  const { rows } = await client.query(`SELECT ${selected.map((name) => '`' + name + '`').join(', ')} FROM orders ORDER BY id`);
  console.log(JSON.stringify({
    read_only: true,
    missing_columns: requested.filter((name) => !columns.has(name)),
    ...auditOrderRecords(rows),
  }, null, 2));
} catch (error) {
  console.error('Order audit could not finish:', error.code || error.message);
  process.exitCode = 1;
} finally {
  if (client) {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
  await pool.end();
}
