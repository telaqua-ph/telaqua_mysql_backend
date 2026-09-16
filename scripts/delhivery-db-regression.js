// Explicit opt-in, loopback only, new random database, synthetic data only.
// Does not load .env and never calls the courier. Run outside `npm test`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

if (process.env.DELHIVERY_DB_LAB !== '1' || !process.env.LAB_DB_PORT) {
  throw new Error('Set DELHIVERY_DB_LAB=1 and LAB_DB_PORT for a disposable loopback database.');
}
const dbName = `delhivery_lab_${randomUUID().replaceAll('-', '')}`;
const options = {
  host: '127.0.0.1', port: Number(process.env.LAB_DB_PORT),
  user: process.env.LAB_DB_USER || 'root', password: process.env.LAB_DB_PASSWORD || '',
  charset: 'utf8mb4_general_ci',
};
const admin = await mysql.createConnection(options);
let pool;
const savedFetch = globalThis.fetch;
const failures = [];
const savedError = console.error;
let created = false;
let passed = 0;
function pass(label) { passed++; console.log(`PASS ${label}`); }
try {
  console.log(JSON.stringify((await admin.query('SELECT VERSION() AS version, @@version_comment AS engine'))[0][0]));
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  created = true;
  await admin.query(`USE \`${dbName}\``);
  await admin.query('SET collation_connection=utf8mb4_unicode_ci');
  await admin.query('CREATE TABLE orders (id INT PRIMARY KEY, fulfillment_status VARCHAR(32)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
  const schema = readFileSync(new URL('../sql/add_delhivery_logistics.sql', import.meta.url), 'utf8');
  for (const ddl of schema.matchAll(/CREATE TABLE IF NOT EXISTS[\s\S]*?;/g)) await admin.query(ddl[0]);
  await admin.query('CREATE UNIQUE INDEX uq_tracking_event_key ON shipment_tracking_history (shipment_id,event_key)');
  await admin.query('ALTER TABLE shipment_tracking_history MODIFY location VARCHAR(255) COLLATE utf8mb4_bin NULL');
  await admin.query('INSERT INTO orders VALUES (1,\'shipment_created\'),(2,\'shipment_created\')');
  await admin.query(`INSERT INTO shipments (id,order_id,idempotency_key,environment,waybill_number,fulfillment_status)
    VALUES (1,1,'lab:1','staging','99999999000001','shipment_created'),(2,2,'lab:2','staging','99999999000002','shipment_created')`);

  const oldDate = "COALESCE(event_time, '1970-01-01') = COALESCE(?, '1970-01-01')";
  const newDate = 'event_time <=> CAST(? AS DATETIME)';
  const original = `INSERT INTO shipment_tracking_history
    (shipment_id,status,status_code,fulfillment_status,location,instructions,event_time,raw_event)
    SELECT ?,?,?,?,?,?,?,? FROM DUAL WHERE NOT EXISTS (
      SELECT 1 FROM shipment_tracking_history WHERE shipment_id=?
      AND (status) COLLATE utf8mb4_unicode_ci = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci
      AND ${oldDate}
      AND (CONVERT(IFNULL(location, '') USING utf8mb4)) COLLATE utf8mb4_unicode_ci = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci)`;
  const params = [1,'In Transit',null,'in_transit','Lab',null,'2026-09-16 01:02:03','{}',1,'In Transit','2026-09-16 01:02:03','Lab'];
  console.log('Derived expression diagnostics:', (await admin.execute(`SELECT
    COLLATION(?) AS parameter_collation, COLLATION(COALESCE(?, '1970-01-01')) AS derived_collation,
    COERCIBILITY(COALESCE(?, '1970-01-01')) AS derived_coercibility`, Array(3).fill(params[6])))[0]);
  await assert.rejects(admin.execute(original, params), error => {
    assert.equal(error.code, 'ER_CANT_AGGREGATE_2COLLATIONS');
    assert.match(error.message, /utf8mb4_unicode_ci,COERCIBLE.*utf8mb4_bin,NONE/);
    console.log('Reproduced:', error.message);
    return true;
  });
  pass('original full INSERT fails with exact reported collation pair');
  const fixed = original.replace(oldDate, newDate);
  assert.equal((await admin.execute(fixed, params))[0].affectedRows, 1);
  assert.equal((await admin.execute(fixed, params))[0].affectedRows, 0);
  pass('typed comparison inserts once, then deduplicates');
  const equivalent = [...params];
  equivalent[1] = equivalent[9] = 'IN TRANSIT';
  equivalent[4] = equivalent[11] = 'Láb';
  assert.equal((await admin.execute(fixed, equivalent))[0].affectedRows, 0);
  pass('previous helper retains case/accent insensitive status/location semantics on binary column');
  const nulls = [...params];
  nulls[6] = nulls[10] = null;
  nulls[4] = null; nulls[11] = '';
  assert.equal((await admin.execute(fixed, nulls))[0].affectedRows, 1);
  nulls[4] = '';
  assert.equal((await admin.execute(fixed, nulls))[0].affectedRows, 0);
  const epoch = [...nulls]; epoch[6] = epoch[10] = '1970-01-01 00:00:00';
  assert.equal((await admin.execute(fixed, epoch))[0].affectedRows, 1);
  pass('NULL time repeats deduplicate; NULL/empty location equivalent; real epoch distinct from NULL');
  const different = [...params]; different[4] = different[11] = 'Other Lab';
  assert.equal((await admin.execute(fixed, different))[0].affectedRows, 1);
  different[6] = different[10] = '2026-09-16 01:02:04';
  assert.equal((await admin.execute(fixed, different))[0].affectedRows, 1);
  pass('different location and second remain separate history events');
  // Compare baseline behavior on a compatible session, including epoch/NULL.
  const compatible = await mysql.createConnection({ ...options, database: dbName, charset: 'utf8mb4_unicode_ci' });
  try {
    const cases = [null, '1970-01-01 00:00:00', '2026-09-16 01:02:03'];
    for (const left of cases) for (const right of cases) {
      const [rows] = await compatible.execute(`SELECT ${oldDate} AS old_result, ${newDate} AS new_result
        FROM (SELECT CAST(? AS DATETIME) AS event_time) AS dates`, [right, right, left]);
      assert.equal(rows[0].old_result, rows[0].new_result);
    }
  } finally { await compatible.end(); }
  pass('old/new date semantics agree for NULL, epoch, and ordinary date matrix');
  await admin.query('DELETE FROM shipment_tracking_history');

  Object.assign(process.env, {
    DB_HOST: options.host, DB_PORT: String(options.port), DB_NAME: dbName,
    DB_USER: options.user, DB_PASSWORD: options.password,
    DELHIVERY_ENV: 'staging', DELHIVERY_API_TOKEN: 'synthetic-lab-token',
    DELHIVERY_STAGING_TRACKING_URL: 'https://courier.invalid/api/tracking',
    DELHIVERY_TRACKING_PACE_MS: '25',
    DELHIVERY_WEBHOOK_AUTH_HEADER: 'x-lab-auth', DELHIVERY_WEBHOOK_AUTH_VALUE: 'synthetic-lab-auth',
    DELHIVERY_WEBHOOK_ALLOWED_IPS: '',
  });
  ({ pool } = await import('../config/db.js'));
  // Deliberate test-only handshake/session mismatch to exercise the exact failure.
  if (!process.argv.includes('--matched-connection')) {
    pool._mysql.pool.config.connectionConfig.charsetNumber = 45; // utf8mb4_general_ci
  }
  pool._mysql.on('connection', connection => connection.query('SET collation_connection=utf8mb4_unicode_ci'));
  const { refreshOneShipment } = await import('../controllers/logisticsController.js');
  const { runTrackingSync } = await import('../services/logisticsSyncService.js');
  const { persistDelhiveryScanPush, parseDelhiveryScanPush } = await import('../services/delhiveryWebhookService.js');
  const { createDelhiveryWebhookHandler } = await import('../controllers/delhiveryWebhookController.js');
  const { trackShipment } = await import('../services/delhiveryService.js');
  let status = 'In Transit';
  let date = '2026-09-16 12:00:00';
  let mode = 'success';
  const requests = [];
  let attempts = 0;
  globalThis.fetch = async url => {
    assert.equal(new URL(url).hostname, 'courier.invalid');
    requests.push(Date.now()); attempts++;
    if (mode === '429' || (mode === 'recover' && attempts < 3)) {
      return new Response(JSON.stringify({ message: 'Throttled, wait 1 seconds.' }), { status: 429, headers: { 'Retry-After': '1' } });
    }
    if (mode === 'missing') return new Response(JSON.stringify({ error: 'Data does not exists for provided Waybill(s)' }), { status: 200 });
    return new Response(JSON.stringify({ ShipmentData: [{ Shipment: {
      Status: { Status: status, StatusDateTime: date, StatusLocation: 'Lab' },
      Scans: [{ ScanDetail: { Scan: status, ScanDateTime: date, ScannedLocation: 'Lab' } }],
    } }] }), { status: 200 });
  };
  console.error = (...args) => { failures.push(args); savedError(...args); };
  await runTrackingSync();
  assert.equal(failures.length, 0);
  assert.equal(requests.length, 2);
  assert.ok(requests[1] - requests[0] >= 25);
  assert.deepEqual((await admin.query('SELECT fulfillment_status FROM shipments ORDER BY id'))[0].map(r => r.fulfillment_status), ['in_transit','in_transit']);
  assert.equal((await admin.query('SELECT COUNT(*) n FROM shipment_tracking_history'))[0][0].n, 2);
  assert.equal((await admin.query('SELECT COUNT(*) n FROM shipment_audit_log'))[0][0].n, 2);
  assert.deepEqual((await admin.query('SELECT fulfillment_status FROM orders ORDER BY id'))[0].map(r => r.fulfillment_status), ['in_transit','in_transit']);
  pass('actual scheduled batch persists both shipments, orders, history and audit with pacing');
  assert.equal((await refreshOneShipment({ id: 1 })).events_added, 0);
  date = '2026-09-15 12:00:00'; status = 'Pending';
  assert.equal((await refreshOneShipment({ id: 1 })).stale_ignored, true);
  assert.equal((await admin.query('SELECT fulfillment_status FROM shipments WHERE id=1'))[0][0].fulfillment_status, 'in_transit');
  pass('scheduled duplicate and older-event paths');

  function payload(time = '2026-09-16 13:00:00', state = 'Delivered') {
    return { Shipment: { AWB: '99999999000001', Status: { Status: state, StatusType: 'DL', StatusDateTime: time, StatusLocation: 'Lab' } } };
  }
  const handler = createDelhiveryWebhookHandler(pool);
  async function webhook(body) {
    const response = { statusCode: 0, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
    await handler({ get: () => 'synthetic-lab-auth', body: Buffer.from(JSON.stringify(body)) }, response);
    assert.equal(response.statusCode, 200);
    return response.body;
  }
  assert.equal((await webhook(payload())).applied, true);
  assert.equal((await webhook(payload())).duplicate, true);
  assert.equal((await webhook(payload('2026-09-14 12:00:00','Pending'))).applied, false);
  assert.equal((await admin.query('SELECT fulfillment_status FROM orders WHERE id=1'))[0][0].fulfillment_status, 'delivered');
  const concurrent = parseDelhiveryScanPush(payload('2026-09-16 14:00:00'));
  const outcomes = await Promise.all([persistDelhiveryScanPush(concurrent, pool), persistDelhiveryScanPush(concurrent, pool)]);
  assert.equal(outcomes.filter(r => r.duplicate).length, 1);
  pass('actual webhook handler, duplicate protection, concurrent delivery, older-event non-regression');

  await admin.query(`CREATE TRIGGER lab_order_failure BEFORE UPDATE ON orders FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic-sensitive-value'`);
  const before = (await admin.query('SELECT COUNT(*) n FROM shipment_tracking_history'))[0][0].n;
  const rollback = parseDelhiveryScanPush(payload('2026-09-16 15:00:00'));
  await assert.rejects(persistDelhiveryScanPush(rollback, pool), { code: 'ER_SIGNAL_EXCEPTION' });
  assert.equal((await admin.query('SELECT COUNT(*) n FROM shipment_tracking_history'))[0][0].n, before);
  assert.equal((await admin.query("SELECT DATE_FORMAT(shipment_status_at, '%H:%i:%s') t FROM shipments WHERE id=1"))[0][0].t, '14:00:00');
  assert.ok(failures.some(entry => entry[1]?.stage === 'webhook.order.update'));
  assert.ok(!JSON.stringify(failures).includes('synthetic-sensitive-value'));
  assert.ok(failures.some(entry => entry[1]?.stack?.includes('delhiveryWebhookService')));
  await admin.query('DROP TRIGGER lab_order_failure');
  failures.length = 0;
  pass('trigger failure rolls back entire webhook and logs stage/source frames without SQL/error data');

  mode = 'recover'; attempts = 0;
  await trackShipment('99999999000002');
  assert.equal(attempts, 3);
  mode = '429'; attempts = 0;
  await assert.rejects(trackShipment('99999999000002'), { code: 'DELHIVERY_THROTTLED' });
  assert.equal(attempts, 3);
  pass('429 recovery and exhausted retries both bounded at three attempts');
  failures.length = 0; // Expected upstream 429 logs above are not DB failures.
  mode = 'missing';
  await admin.query('UPDATE shipments SET last_tracking_update=NULL WHERE id=2');
  await runTrackingSync();
  assert.equal(failures.length, 0);
  assert.deepEqual((await admin.query('SELECT last_tracking_update IS NOT NULL touched, processing_token IS NULL unlocked FROM shipments WHERE id=2'))[0][0], { touched: 1, unlocked: 1 });
  pass('missing-AWB scheduled path retains cooldown and releases operation lock');
  mode = 'success'; date = '2026-09-16 16:00:00'; status = 'Delivered';
  await refreshOneShipment({ id: 2 });
  assert.deepEqual((await admin.query('SELECT fulfillment_status, delivered_at IS NOT NULL delivered FROM shipments WHERE id=2'))[0][0], { fulfillment_status: 'delivered', delivered: 1 });
  pass('scheduled delivered timestamp CASE/COALESCE persists on the real database');
  console.log(`PASS ${passed} real database checks`);
} finally {
  globalThis.fetch = savedFetch;
  console.error = savedError;
  await pool?.end();
  // Only the uniquely named database created by this invocation can be removed.
  if (created) await admin.query(`DROP DATABASE \`${dbName}\``);
  await admin.end();
}
