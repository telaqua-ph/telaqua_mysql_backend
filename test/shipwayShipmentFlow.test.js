import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../config/db.js";
import {
  acquireShipmentOperation,
  createOrderShipment,
  generateWaybill,
  pickupShipment,
  reconcileOrderShipment,
  refreshActiveTracking,
} from "../controllers/logisticsController.js";
import { buildShipwayPayload } from "../services/shipwayPayload.js";
import { assertShipwayBookingSucceeded, findShipwayOrder } from "../services/shipwayService.js";
import { DELHIVERY_ONLY_SQL, assertDelhiveryManagedShipment, isShipwayShipment } from "../services/shipmentProvider.js";
import { deriveShipmentStatusDisplay } from "../services/shipmentStatusDisplay.js";
import { isCustomerCodCancellable } from "../services/customerCodCancel.js";

const env = process.env;
Object.assign(env, {
  SHIPWAY_EMAIL: "merchant@example.test",
  SHIPWAY_LICENSE_KEY: "test-license",
  SHIPWAY_WAREHOUSE_ID: "109177",
  SHIPWAY_RETURN_WAREHOUSE_ID: "109177",
  TELAQUA_PRODUCT_WEIGHT_GM: "350",
  TELAQUA_PRODUCT_LENGTH_CM: "25",
  TELAQUA_PRODUCT_WIDTH_CM: "20",
  TELAQUA_PRODUCT_HEIGHT_CM: "8",
  TELAQUA_WAREHOUSE_PINCODE: "560001",
  TELAQUA_WAREHOUSE_NAME: "Tel-Aqua",
  TELAQUA_WAREHOUSE_ADDRESS: "1 Test Road",
  TELAQUA_WAREHOUSE_CITY: "Bengaluru",
  TELAQUA_WAREHOUSE_STATE: "Karnataka",
  TELAQUA_WAREHOUSE_PHONE: "9000000000",
});

const product = { name: "Tel-Aqua pH Meter", weightGm: 350, lengthCm: 25, widthCm: 20, heightCm: 8 };
const baseOrder = {
  id: 873, order_number: "TAQ-000873", customer_name: "Asha Rao", phone: "9876543210",
  email: "asha@example.test", address: "12 Lake Road", city: "Bengaluru", state: "Karnataka",
  pincode: "560001", quantity: 1, unit_price: 499, final_total: 499, payment_mode: "cod",
  payment_status: "Pending", created_at: "2026-10-05T09:00:00Z",
};

const NO_COURIER = { success: false, message: "carrier_id does not exist.", awb_response: "No Courier Found." };
const BOOKED = { success: true, message: "Order created", awb_response: { success: true, AWB: "SW900873", carrier_id: 3411, carrier_name: "Delhivery Surface", shipping_url: "https://labels.example/SW900873.pdf" } };
const NOT_FOUND = { success: 1, error: "", message: "No order found" };

/* ---------- In-memory MySQL stand-in for the statements the logistics controller issues ---------- */

/** Split a SET list on commas that are not inside parentheses or quotes. */
function splitAssignments(text) {
  const parts = [];
  let depth = 0, quote = false, current = "";
  for (const ch of text) {
    if (ch === "'") quote = !quote;
    if (!quote && ch === "(") depth += 1;
    if (!quote && ch === ")") depth -= 1;
    if (!quote && depth === 0 && ch === ",") { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function createFakeDb({ orders = [], shipments = [] } = {}) {
  const db = {
    orders: new Map(orders.map((row) => [row.id, { ...row }])),
    shipments: new Map(shipments.map((row) => [row.id, { processing_token: null, processing_started_at: null, ...row }])),
    audit: [],
    statements: [],
    nextShipmentId: 1000,
  };

  function update(table, sql, params) {
    const match = sql.match(/^UPDATE (\w+) SET ([\s\S]+?) WHERE ([\s\S]+)$/i);
    const setters = [];
    let index = 0;
    for (const assignment of splitAssignments(match[2])) {
      const [column, expression] = assignment.split(/=(.*)/s).map((part) => part.trim());
      if (expression === "?") { const value = params[index++]; setters.push([column, () => value]); }
      else if (expression === "NULL") setters.push([column, () => null]);
      else if (expression === "NOW()") setters.push([column, () => new Date()]);
      else if (/^'.*'$/.test(expression)) setters.push([column, () => expression.slice(1, -1)]);
      else if (/^COALESCE\(\w+, NOW\(\)\)$/i.test(expression)) setters.push([column, (row) => row[column] ?? new Date()]);
      else throw new Error(`Fake DB cannot evaluate: ${assignment}`);
    }
    const predicates = match[3].split(/\s+AND\s+/i).map((part) => part.trim()).map((condition) => {
      let found;
      if ((found = condition.match(/^(\w+)\s*=\s*\?$/))) { const value = params[index++]; return (row) => row[found[1]] != null && String(row[found[1]]) === String(value); }
      if ((found = condition.match(/^(\w+)\s*<=>\s*\?$/))) { const value = params[index++]; return (row) => (row[found[1]] ?? null) === (value ?? null); }
      if ((found = condition.match(/^(\w+) IS NULL$/i))) return (row) => row[found[1]] == null;
      throw new Error(`Fake DB cannot evaluate condition: ${condition}`);
    });
    const rows = [...db[table].values()].filter((row) => predicates.every((predicate) => predicate(row)));
    for (const row of rows) for (const [column, value] of setters) row[column] = value(row);
    return { rows: [], rowCount: rows.length };
  }

  async function run(rawSql, params = []) {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    db.statements.push({ sql, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/^SELECT \* FROM orders WHERE id ?= ?\?/i.test(sql)) return rowsOf(db.orders.get(Number(params[0])));
    if (/^SELECT \* FROM shipments WHERE order_id = \? AND sequence_no = 1/i.test(sql)) {
      return rowsOf([...db.shipments.values()].find((row) => row.order_id === Number(params[0])));
    }
    if (/^SELECT \* FROM shipments WHERE id = \?/i.test(sql)) return rowsOf(db.shipments.get(Number(params[0])));
    if (/^SELECT \* FROM shipments WHERE waybill_number IS NOT NULL/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/^INSERT INTO shipments \(order_id/i.test(sql)) {
      const id = db.nextShipmentId++;
      db.shipments.set(id, { id, order_id: params[0], sequence_no: 1, idempotency_key: params[1], environment: params[2], fulfillment_status: "unfulfilled", provider: null, courier_name: "Delhivery", processing_token: null, processing_started_at: null });
      return { rows: [], rowCount: 1, insertId: id };
    }
    if (/^INSERT INTO shipment_audit_log/i.test(sql)) { db.audit.push({ shipmentId: params[0], action: params[2], after: params[4] }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE shipments /i.test(sql)) return update("shipments", sql, params);
    if (/^UPDATE orders /i.test(sql)) return update("orders", sql, params);
    throw new Error(`Fake DB received unexpected SQL: ${sql}`);
  }
  const rowsOf = (row) => (row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 });

  db.client = { query: run, release() {} };
  db.query = run;
  return db;
}

async function withHarness({ db, responses = [] }, body) {
  const saved = { connect: pool.connect, query: pool.query, fetch: globalThis.fetch, warn: console.warn, info: console.info, error: console.error };
  const calls = [];
  const logs = [];
  pool.connect = async () => db.client;
  pool.query = db.query;
  globalThis.fetch = async (url, request = {}) => {
    const href = String(url);
    calls.push({ url: href, method: request.method || "GET", body: request.body ? JSON.parse(request.body) : null });
    const carrierLookup = /\/api\/getcarrier$/.test(href);
    const pincodeLookup = /\/api\/pincodeserviceable\?/.test(href);
    const next = carrierLookup && !responses[0]?.match?.test(href)
      ? { match: /\/api\/getcarrier$/, body: { success: 1, message: [{ id: "3411", name: "Delhivery Surface" }] } }
      // Pincode check is best-effort; unless a test queues one, answer "unknown" (no filtering).
      : pincodeLookup && !responses[0]?.match?.test(href)
        ? { match: /\/api\/pincodeserviceable\?/, body: { success: 0, message: "not available" } }
        : responses.shift();
    if (!next) throw new Error(`Unexpected outbound request: ${href.replace(/\?.*/, "")}`);
    assert.match(href, next.match, "outbound request went to the wrong Shipway endpoint");
    return new Response(JSON.stringify(next.body), { status: next.status || 200 });
  };
  console.warn = (...args) => logs.push(args);
  console.info = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  try {
    await body({ calls, logs });
    assert.equal(responses.length, 0, "every expected Shipway response must be consumed");
  } finally {
    Object.assign(pool, { connect: saved.connect, query: saved.query });
    globalThis.fetch = saved.fetch;
    Object.assign(console, { warn: saved.warn, info: saved.info, error: saved.error });
  }
}

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function call(handler, req) {
  const res = mockRes();
  await handler({ user: { admin_id: 7 }, body: {}, query: {}, ...req }, res);
  return res;
}

const shipmentRow = (overrides = {}) => ({ id: 1, order_id: 873, sequence_no: 1, environment: "staging", fulfillment_status: "unfulfilled", provider: null, courier_name: "Delhivery", ...overrides });
const v2orders = (body, status = 200) => ({ match: /\/api\/v2orders$/, body, status });
const getcarrier = (body, status = 200) => ({ match: /\/api\/getcarrier$/, body, status });
const getorders = (body, status = 200) => ({ match: /\/api\/getorders\?orderid=TAQ-000873$/, body, status });
const assertNoSecrets = (logs) => {
  const text = JSON.stringify(logs);
  for (const secret of ["test-license", "merchant@example.test", "9876543210", "asha@example.test", "12 Lake Road"]) {
    assert.equal(text.includes(secret), false, `logs must not contain ${secret}`);
  }
};

/* ---------- Payload ---------- */

test("Shipway payload includes a validated carrier_id", () => {
  assert.equal(buildShipwayPayload(baseOrder, product, { carrierId: "3411" }).carrier_id, 3411);
  assert.equal(Object.hasOwn(buildShipwayPayload(baseOrder, product, { carrierId: "invalid" }), "carrier_id"), false);
});

test("Shipway payload has no undefined keys and omits a blank email", () => {
  const payload = buildShipwayPayload({ ...baseOrder, email: "  " }, product);
  assert.equal(Object.hasOwn(payload, "email"), false);
  assert.equal(Object.values(payload).some((value) => value === undefined), false);
  assert.equal(buildShipwayPayload(baseOrder, product).email, "asha@example.test");
});

/* ---------- Booking response handling ---------- */

test("success requires both success flags, a non-empty AWB, and an http(s) label URL", () => {
  assert.deepEqual(assertShipwayBookingSucceeded({ success: 1, awb_response: { success: 1, AWB: "SW1", carrier_id: 3411, courier_name: "Bluedart", shipping_url: "http://labels.example/1.pdf" } }),
    { awb: "SW1", labelUrl: "http://labels.example/1.pdf", carrierId: "3411", carrierName: "Bluedart" });
  for (const body of [
    { success: true, awb_response: { success: true, AWB: "SW1", shipping_url: "labels.example/1.pdf" } },
    { success: true, awb_response: { success: true, AWB: "SW1", shipping_url: "javascript:alert(1)" } },
    { success: true, awb_response: { success: true, AWB: "  ", shipping_url: "https://labels.example/1.pdf" } },
    { success: true, awb_response: { success: false, AWB: "SW1", shipping_url: "https://labels.example/1.pdf" } },
    { success: false, awb_response: { success: true, AWB: "SW1", shipping_url: "https://labels.example/1.pdf" } },
  ]) {
    assert.throws(() => assertShipwayBookingSucceeded(body), { code: "SHIPWAY_PARTIAL_OR_REJECTED" });
  }
});

test("No Courier Found surfaces Shipway's text plus courier activation guidance", () => {
  const saved = console.warn;
  console.warn = () => {};
  try {
    assert.throws(() => assertShipwayBookingSucceeded(NO_COURIER), (error) => {
      assert.equal(error.code, "SHIPWAY_PARTIAL_OR_REJECTED");
      assert.match(error.message, /carrier_id does not exist\./);
      assert.match(error.message, /No Courier Found\./);
      assert.match(error.message, /activate a courier and courier priority rule in Shipway/);
      return true;
    });
  } finally { console.warn = saved; }
});

/* ---------- Lookup ---------- */

test("getorders 'No order found' is confirmed_absent; unknown bodies keep the lock", async () => {
  const db = createFakeDb();
  await withHarness({ db, responses: [getorders(NOT_FOUND), getorders({ success: 1, message: "No orders found." }), getorders({ success: 1, message: "Service busy" })] }, async ({ calls }) => {
    assert.equal((await findShipwayOrder("TAQ-000873")).state, "confirmed_absent");
    assert.equal((await findShipwayOrder("TAQ-000873")).state, "confirmed_absent");
    await assert.rejects(() => findShipwayOrder("TAQ-000873"), { code: "SHIPWAY_RECONCILIATION_FAILED" });
    assert.ok(calls.every((entry) => entry.method === "GET" && !/v2orders/.test(entry.url)));
  });
});

test("'No order found' with an AWB present is not treated as absent", async () => {
  const db = createFakeDb();
  await withHarness({ db, responses: [getorders({ success: 1, message: "No order found", orders: [{ awb_number: "SW1", shipping_url: "https://labels.example/1.pdf" }] })] }, async () => {
    assert.equal((await findShipwayOrder("TAQ-000873")).state, "exists");
  });
});

/* ---------- Create shipment flow ---------- */

test("successful booking saves provider, carrier, AWB, label and Ready to Ship; a second click does not rebook", async () => {
  const db = createFakeDb({ orders: [baseOrder] });
  await withHarness({ db, responses: [v2orders(BOOKED)] }, async ({ calls, logs }) => {
    const first = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(first.statusCode, 201, JSON.stringify(first.body));
    const [shipment] = db.shipments.values();
    assert.equal(shipment.provider, "Shipway");
    assert.equal(shipment.carrier_id, "3411");
    assert.equal(shipment.courier_name, "Delhivery Surface");
    assert.equal(shipment.waybill_number, "SW900873");
    assert.equal(shipment.shipping_label_url, "https://labels.example/SW900873.pdf");
    assert.equal(shipment.fulfillment_status, "ready_to_ship");
    assert.equal(shipment.shipment_status, "Ready to Ship");
    assert.equal(shipment.processing_token, null);
    assert.equal(db.orders.get(873).fulfillment_status, "ready_to_ship");
    assert.equal(db.audit.at(-1).action, "shipway_shipment_created");

    const second = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.already_created, true);
    assert.equal(second.body.waybill, "SW900873");
    assert.equal(calls.length, 3, "only the first click may call Shipway (getcarrier, pincodeserviceable, v2orders)");

    const verification = logs.find(([label]) => label === "[Shipway] outgoing booking verification");
    assert.equal(verification[1].autoAssignment, false);
    assert.equal(verification[1].carrierId, 3411);
    assert.equal(verification[1].payloadKeys.includes("carrier_id"), true);
    assert.equal(verification[1].orderNumber, "TAQ-000873");
    assertNoSecrets(logs);
  });
});

test("rejected booking saves nothing, releases the lock, and a retry looks up then books exactly once", async () => {
  const db = createFakeDb({ orders: [baseOrder] });
  await withHarness({ db, responses: [v2orders(NO_COURIER, 202), getorders(NOT_FOUND), v2orders(NO_COURIER, 202), getorders(NOT_FOUND), v2orders(BOOKED)] }, async ({ calls, logs }) => {
    const rejected = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(rejected.statusCode, 422);
    assert.equal(rejected.body.retryable, true);
    assert.match(rejected.body.message, /No Courier Found/);
    assert.match(rejected.body.message, /activate a courier and courier priority rule in Shipway/);
    const [shipment] = db.shipments.values();
    assert.equal(shipment.waybill_number ?? null, null);
    assert.equal(shipment.shipping_label_url ?? null, null);
    assert.equal(shipment.shipment_created_at ?? null, null);
    assert.equal(shipment.fulfillment_status, "unfulfilled");
    assert.equal(shipment.shipment_status, "Booking Failed");
    assert.notEqual(shipment.shipment_status, "Ready to Ship");
    assert.equal(shipment.processing_token, null);
    assert.notEqual(db.orders.get(873).fulfillment_status, "ready_to_ship");
    assert.match(shipment.last_error, /No Courier Found/);

    const retry = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(retry.statusCode, 201, JSON.stringify(retry.body));
    assert.deepEqual(calls.map((entry) => entry.url.replace(/\?.*/, "").split("/").at(-1)), ["getcarrier", "pincodeserviceable", "v2orders", "getorders", "v2orders", "getorders", "getcarrier", "pincodeserviceable", "v2orders"]);
    assert.equal(shipment.processing_token, null);
    assert.equal(db.shipments.get(shipment.id).waybill_number, "SW900873");
    assertNoSecrets(logs);
  });
});

test("retry after a previous attempt saves an existing Shipway AWB instead of rebooking", async () => {
  const db = createFakeDb({ orders: [baseOrder], shipments: [shipmentRow({ provider: "Shipway", courier_name: "Shipway", shipment_status: "Booking Failed" })] });
  const existing = { success: 1, message: [{ order_id: "TAQ-000873", awb: "SW555", carrier_id: "3411", courier_name: "Xpressbees", shipping_url: "https://labels.example/SW555.pdf" }] };
  await withHarness({ db, responses: [getorders(existing)] }, async ({ calls }) => {
    const res = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.reconciled, true);
    const shipment = db.shipments.get(1);
    assert.equal(shipment.waybill_number, "SW555");
    assert.equal(shipment.shipment_status, "Ready to Ship");
    assert.equal(shipment.processing_token, null);
    assert.equal(calls.length, 1);
  });
});

test("retry whose Shipway lookup fails releases its own lock and does not book", async () => {
  const db = createFakeDb({ orders: [baseOrder], shipments: [shipmentRow({ provider: "Shipway", courier_name: "Shipway", shipment_status: "Booking Failed" })] });
  await withHarness({ db, responses: [getorders({ message: "Service busy" }, 503)] }, async ({ calls }) => {
    const res = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.statusCode, 409);
    assert.equal(db.shipments.get(1).processing_token, null);
    assert.equal(db.shipments.get(1).waybill_number ?? null, null);
    assert.equal(calls.filter((entry) => /v2orders/.test(entry.url)).length, 0);
  });
});

test("an uncertain booking outcome keeps the lock", async () => {
  const db = createFakeDb({ orders: [baseOrder] });
  const partial = { success: true, awb_response: { success: true, AWB: "SW1" } };
  await withHarness({ db, responses: [v2orders(partial)] }, async () => {
    const res = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.statusCode, 409);
    const [shipment] = db.shipments.values();
    assert.ok(shipment.processing_token, "lock must be kept for reconciliation");
    assert.equal(shipment.waybill_number ?? null, null);
  });
});

test("no active Shipway carrier releases the lock and never calls v2orders", async () => {
  const db = createFakeDb({ orders: [baseOrder] });
  await withHarness({ db, responses: [getcarrier({ success: 1, message: "No carrier found" })] }, async ({ calls }) => {
    const res = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.retryable, true);
    assert.match(res.body.message, /No active Shipway carrier/);
    assert.equal(calls.filter((entry) => /v2orders/.test(entry.url)).length, 0);
    const [shipment] = db.shipments.values();
    assert.equal(shipment.processing_token, null);
    assert.equal(shipment.waybill_number ?? null, null);
  });
});

/* ---------- Reconcile ---------- */

const lockedShipment = () => shipmentRow({ provider: "Shipway", courier_name: "Shipway", processing_token: "stale-lock", processing_started_at: new Date(Date.now() - 5 * 60_000) });

test("reconcile: confirmed_absent releases only the matching lock and never calls v2orders", async () => {
  const db = createFakeDb({ orders: [baseOrder], shipments: [lockedShipment()] });
  await withHarness({ db, responses: [getorders(NOT_FOUND)] }, async ({ calls }) => {
    const res = await call(reconcileOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.released, true);
    assert.equal(db.shipments.get(1).processing_token, null);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].url, /v2orders/);
    const release = db.statements.find(({ sql }) => /SET processing_token=NULL/.test(sql));
    assert.match(release.sql, /WHERE id=\? AND processing_token=\?/);
    assert.equal(release.params.at(-1), "stale-lock");
  });
});

test("reconcile: existing AWB and label are saved as Ready to Ship with an audit entry", async () => {
  const db = createFakeDb({ orders: [baseOrder], shipments: [lockedShipment()] });
  const existing = { success: 1, message: [{ order_id: "TAQ-000873", awb: "SW777", carrier_id: "3411", carrier_name: "Ekart", shipping_url: "https://labels.example/SW777.pdf" }] };
  await withHarness({ db, responses: [getorders(existing)] }, async ({ calls }) => {
    const res = await call(reconcileOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const shipment = db.shipments.get(1);
    assert.deepEqual(
      [shipment.provider, shipment.carrier_id, shipment.courier_name, shipment.waybill_number, shipment.shipping_label_url, shipment.fulfillment_status, shipment.shipment_status, shipment.processing_token],
      ["Shipway", "3411", "Ekart", "SW777", "https://labels.example/SW777.pdf", "ready_to_ship", "Ready to Ship", null]
    );
    assert.equal(db.audit.at(-1).action, "shipway_reconciled");
    assert.equal(calls.length, 1);
  });
});

test("reconcile: an unknown body or an order without a label keeps the lock and returns 409", async () => {
  for (const body of [{ success: 1, message: "Something unexpected" }, { success: 1, message: [{ order_id: "TAQ-000873", awb: "SW8" }] }]) {
    const db = createFakeDb({ orders: [baseOrder], shipments: [lockedShipment()] });
    await withHarness({ db, responses: [getorders(body)] }, async ({ calls }) => {
      const res = await call(reconcileOrderShipment, { params: { orderId: "873" } });
      assert.equal(res.statusCode, 409);
      assert.equal(db.shipments.get(1).processing_token, "stale-lock");
      assert.equal(db.shipments.get(1).waybill_number ?? null, null);
      assert.ok(calls.every((entry) => !/v2orders/.test(entry.url)));
    });
  }
});

test("create on a stale locked Shipway row reconciles by lookup only", async () => {
  const db = createFakeDb({ orders: [baseOrder], shipments: [lockedShipment()] });
  await withHarness({ db, responses: [getorders(NOT_FOUND)] }, async ({ calls }) => {
    const res = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.body.released, true);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].url, /v2orders/);
  });
});

/* ---------- Delhivery isolation ---------- */

test("Delhivery shipments and legacy AWB orders are never sent to Shipway and are left unchanged", async () => {
  const cases = [
    { order: baseOrder, shipment: shipmentRow({ provider: "Delhivery", waybill_number: "1234567890", shipment_created_at: new Date() }) },
    { order: baseOrder, shipment: shipmentRow({ provider: "Delhivery" }) },
    { order: { ...baseOrder, waybill: "1234567890" }, shipment: shipmentRow() },
  ];
  for (const { order, shipment } of cases) {
    const db = createFakeDb({ orders: [order], shipments: [shipment] });
    const before = JSON.stringify(db.shipments.get(1));
    await withHarness({ db }, async ({ calls }) => {
      const res = await call(createOrderShipment, { params: { orderId: "873" } });
      assert.equal(res.statusCode, 409);
      assert.equal(calls.length, 0);
      assert.equal(JSON.stringify(db.shipments.get(1)), before);
    });
  }
});

test("Shipway shipments are refused by Delhivery operations", async () => {
  assert.equal(isShipwayShipment({ provider: " SHIPWAY " }), true);
  assert.equal(isShipwayShipment({ provider: "Delhivery" }), false);
  assert.equal(isShipwayShipment({ provider: null }), false);
  assert.throws(() => assertDelhiveryManagedShipment({ provider: "shipway" }), { code: "SHIPWAY_MANAGED_SHIPMENT", httpStatus: 409 });
  assert.doesNotThrow(() => assertDelhiveryManagedShipment({ provider: "Delhivery" }));

  const shipway = shipmentRow({ provider: "Shipway", waybill_number: "SW1", shipment_created_at: new Date(), fulfillment_status: "ready_to_ship" });
  const db = createFakeDb({ orders: [baseOrder], shipments: [shipway] });
  const before = JSON.stringify(db.shipments.get(1));
  await withHarness({ db }, async ({ calls }) => {
    await assert.rejects(() => acquireShipmentOperation(1, "tracking"), { code: "SHIPWAY_MANAGED_SHIPMENT" });
    const pickup = await call(pickupShipment, { params: { shipmentId: "1" }, body: { pickup_date: "2026-10-06" } });
    assert.equal(pickup.statusCode, 409);
    assert.equal(pickup.body.code, "SHIPWAY_MANAGED_SHIPMENT");
    const waybill = await call(generateWaybill, { body: { order_id: 873 } });
    assert.equal(waybill.statusCode, 409);
    assert.equal(waybill.body.code, "SHIPWAY_MANAGED_SHIPMENT");
    assert.equal(calls.length, 0);
    assert.equal(JSON.stringify(db.shipments.get(1)), before);

    await call(refreshActiveTracking, { body: {} });
    const tracking = db.statements.find(({ sql }) => /^SELECT \* FROM shipments WHERE waybill_number IS NOT NULL/.test(sql));
    assert.ok(tracking.sql.includes(DELHIVERY_ONLY_SQL));
  });
});

test("Delhivery-only SQL excludes Shipway regardless of case and keeps provider-less rows", () => {
  assert.equal(DELHIVERY_ONLY_SQL, "(provider IS NULL OR LOWER(TRIM(provider)) <> 'shipway')");
});

/* ---------- Display and COD cancel ---------- */

test("Booking Failed without a waybill is displayed as Booking Failed and does not block COD cancel", () => {
  assert.equal(deriveShipmentStatusDisplay({ shipment_status: "Booking Failed", payment_status: "Paid" }), "Booking Failed");
  assert.notEqual(deriveShipmentStatusDisplay({ shipment_status: "Booking Failed", waybill: "123456789", payment_status: "Paid" }), "Pending AWB");
  assert.equal(isCustomerCodCancellable(
    { payment_mode: "cod", payment_status: "Pending", order_status: "Pending" },
    { shipment_status: "Booking Failed", fulfillment_status: "unfulfilled" }
  ), true);
});

test("Booking Failed is shown as-is when orderController feeds shipment_status into tracking_status", () => {
  assert.equal(deriveShipmentStatusDisplay({ tracking_status: "Booking Failed", shipment_status: "Booking Failed", payment_status: "Paid" }), "Booking Failed");
});

test("scheduled Delhivery tracking sync excludes Shipway shipments", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../services/logisticsSyncService.js", import.meta.url), "utf8");
  assert.match(source, /AND \$\{DELHIVERY_ONLY_SQL\}/);
});

/* ---------- Courier priority fallback: Amazon -> Ekart Surface -> any active courier ---------- */

const PRIORITY_CARRIERS = getcarrier({ success: 1, message: [
  { id: "3411", name: "Delhivery Surface" },
  { id: "2", name: "Ekart Air" },
  { id: "5", name: "Ekart Surface" },
  { id: "7", name: "Amazon Shipping" },
] });
const NOT_SERVICEABLE = { success: true, message: "Order has been added successfully", awb_response: { success: false, message: "No shipping services available for this pincode (A-306)" } };
const UNASSIGNED = { success: 1, message: [{ order_id: "TAQ-000873", shipment_status: "Assignment Failed" }] };
const bookedWith = (id, name) => ({ success: true, message: "Order created", awb_response: { success: true, AWB: `AWB${id}`, carrier_id: id, carrier_name: name, shipping_url: `https://labels.example/AWB${id}.pdf` } });
const bookedCarrierIds = (calls) => calls.filter((entry) => /v2orders$/.test(entry.url)).map((entry) => entry.body.carrier_id);

test("Ship Order books Amazon first when Amazon accepts", async () => {
  const db = createFakeDb({ orders: [baseOrder] });
  await withHarness({ db, responses: [PRIORITY_CARRIERS, v2orders(bookedWith(7, "Amazon Shipping"))] }, async ({ calls }) => {
    const res = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepEqual(bookedCarrierIds(calls), [7]);
    assert.equal([...db.shipments.values()][0].courier_name, "Amazon Shipping");
    assert.deepEqual(res.body.courier_attempts, []);
  });
});

test("Amazon cannot deliver -> Ekart Surface is booked (Ekart Air is not preferred)", async () => {
  const db = createFakeDb({ orders: [baseOrder] });
  await withHarness({ db, responses: [PRIORITY_CARRIERS, v2orders(NOT_SERVICEABLE), getorders(UNASSIGNED), v2orders(bookedWith(5, "Ekart Surface"))] }, async ({ calls, logs }) => {
    const res = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepEqual(bookedCarrierIds(calls), [7, 5]);
    const [shipment] = db.shipments.values();
    assert.equal(shipment.courier_name, "Ekart Surface");
    assert.equal(shipment.waybill_number, "AWB5");
    assert.equal(shipment.shipment_status, "Ready to Ship");
    assert.equal(res.body.courier_attempts[0].carrierName, "Amazon Shipping");
    assert.match(res.body.message, /Ekart Surface.*skipped: Amazon Shipping/);
    assertNoSecrets(logs);
  });
});

test("Amazon and Ekart Surface cannot deliver -> next active courier is booked", async () => {
  const db = createFakeDb({ orders: [baseOrder] });
  await withHarness({ db, responses: [
    PRIORITY_CARRIERS,
    v2orders(NOT_SERVICEABLE), getorders(UNASSIGNED),
    v2orders(NOT_SERVICEABLE), getorders(UNASSIGNED),
    v2orders(bookedWith(3411, "Delhivery Surface")),
  ] }, async ({ calls }) => {
    const res = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepEqual(bookedCarrierIds(calls), [7, 5, 3411]);
    assert.equal([...db.shipments.values()][0].courier_name, "Delhivery Surface");
  });
});

test("if a refused courier was assigned after all, it is saved and nothing is booked again", async () => {
  const db = createFakeDb({ orders: [baseOrder] });
  const lateAssigned = { success: 1, message: [{ order_id: "TAQ-000873", awb: "AMZ1", carrier_id: "7", courier_name: "Amazon Shipping", shipping_url: "https://labels.example/AMZ1.pdf" }] };
  await withHarness({ db, responses: [PRIORITY_CARRIERS, v2orders(NOT_SERVICEABLE), getorders(lateAssigned)] }, async ({ calls }) => {
    const res = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepEqual(bookedCarrierIds(calls), [7]);
    assert.equal([...db.shipments.values()][0].waybill_number, "AMZ1");
  });
});

test("no courier accepts (incl. Shipway auto-assign) -> Booking Failed listing every courier; Retry runs the fallback again", async () => {
  const db = createFakeDb({ orders: [baseOrder] });
  const carriers = getcarrier({ success: 1, message: [{ id: "5", name: "Ekart Surface" }, { id: "7", name: "Amazon Shipping" }] });
  await withHarness({ db, responses: [
    carriers, v2orders(NOT_SERVICEABLE), getorders(UNASSIGNED), v2orders(NOT_SERVICEABLE), getorders(UNASSIGNED), v2orders(NOT_SERVICEABLE),
    // Retry: Shipway still holds the unassigned order, so the fallback runs again.
    getorders(UNASSIGNED), carriers, v2orders(NOT_SERVICEABLE), getorders(UNASSIGNED), v2orders(bookedWith(5, "Ekart Surface")),
  ] }, async ({ calls }) => {
    const failed = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(failed.statusCode, 422, JSON.stringify(failed.body));
    assert.match(failed.body.message, /No courier accepted order TAQ-000873 \(pincode 560001\)/);
    assert.match(failed.body.message, /Amazon Shipping \(.*A-306.*\); Ekart Surface \(.*\); Shipway auto-assign/);
    const [shipment] = db.shipments.values();
    assert.equal(shipment.shipment_status, "Booking Failed");
    assert.equal(shipment.processing_token, null);

    const retry = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(retry.statusCode, 201, JSON.stringify(retry.body));
    assert.deepEqual(bookedCarrierIds(calls), [7, 5, undefined, 7, 5]);
    assert.equal(db.shipments.get(shipment.id).courier_name, "Ekart Surface");
  });
});

test("the live Amazon refusal shapes (string, error array, message object) all move on to Ekart Surface", async () => {
  const reason = "Amazon Shipping (carrier_id 19339) No shipping services available for recipient address. Please verify address or contact support. (A-306)";
  const shapes = [
    { success: true, message: "Order has been added successfully", awb_response: reason },
    { success: true, message: "Order has been added successfully", awb_response: { success: false, error: [reason] } },
    { success: "1", message: "Order has been added successfully", awb_response: { success: "0", message: { error: reason } } },
    { success: false, message: reason },
  ];
  for (const shape of shapes) {
    const db = createFakeDb({ orders: [baseOrder] });
    await withHarness({ db, responses: [PRIORITY_CARRIERS, v2orders(shape), getorders(UNASSIGNED), v2orders(bookedWith(5, "Ekart Surface"))] }, async ({ calls }) => {
      const res = await call(createOrderShipment, { params: { orderId: "873" } });
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      assert.deepEqual(bookedCarrierIds(calls), [7, 5]);
      assert.match(res.body.courier_attempts[0].reason, /A-306/);
    });
  }
});

test("a courier that answers nothing is waited for, then the next courier is tried", async () => {
  const db = createFakeDb({ orders: [baseOrder] });
  const accepted = { success: true, message: "Order has been added successfully" };
  await withHarness({ db, responses: [PRIORITY_CARRIERS, v2orders(accepted), getorders(UNASSIGNED), getorders(UNASSIGNED), getorders(UNASSIGNED), v2orders(bookedWith(5, "Ekart Surface"))] }, async ({ calls }) => {
    const res = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepEqual(bookedCarrierIds(calls), [7, 5]);
  });
});

test("every courier is tried, then Shipway auto-assign books whatever courier accepts", async () => {
  const db = createFakeDb({ orders: [baseOrder] });
  const auto = { success: true, message: "Order created", awb_response: { success: true, AWB: "XB1", carrier_id: 88, carrier_name: "Xpressbees", shipping_url: "https://labels.example/XB1.pdf" } };
  await withHarness({ db, responses: [
    PRIORITY_CARRIERS,
    v2orders(NOT_SERVICEABLE), getorders(UNASSIGNED), v2orders(NOT_SERVICEABLE), getorders(UNASSIGNED),
    v2orders(NOT_SERVICEABLE), getorders(UNASSIGNED), v2orders(NOT_SERVICEABLE), getorders(UNASSIGNED),
    v2orders(auto),
  ] }, async ({ calls }) => {
    const res = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepEqual(bookedCarrierIds(calls), [7, 5, 3411, 2, undefined]);
    assert.equal([...db.shipments.values()][0].courier_name, "Xpressbees");
  });
});

test("pincode check skips couriers that cannot serve the pincode before booking", async () => {
  const db = createFakeDb({ orders: [baseOrder] });
  const serviceable = { match: /\/api\/pincodeserviceable\?pincode=560001&payment_type=C$/, body: { success: 1, message: [{ carrier_id: "5", name: "Ekart Surface" }, { carrier_id: "3411", name: "Delhivery Surface" }] } };
  await withHarness({ db, responses: [PRIORITY_CARRIERS, serviceable, v2orders(bookedWith(5, "Ekart Surface"))] }, async ({ calls }) => {
    const res = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepEqual(bookedCarrierIds(calls), [5]);
  });
});

test("a server error or uncertain outcome never falls back to another courier", async () => {
  const db = createFakeDb({ orders: [baseOrder] });
  await withHarness({ db, responses: [PRIORITY_CARRIERS, v2orders({ success: false, message: "Internal error" }, 500)] }, async ({ calls }) => {
    const res = await call(createOrderShipment, { params: { orderId: "873" } });
    assert.notEqual(res.statusCode, 201);
    assert.deepEqual(bookedCarrierIds(calls), [7]);
  });
});
