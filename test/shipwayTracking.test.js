import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../config/db.js";
import {
  SHIPWAY_STATUS_MAP,
  getShipwayTracking,
  mapShipwayStatus,
  normalizeShipwayTime,
  parseShipwayTrackingRecord,
  parseShipwayTrackingResponse,
} from "../services/shipwayService.js";
import {
  isShipwayTrackingSyncEnabled,
  refreshShipwayShipment,
  runShipwayTrackingSync,
  shipwayEventKey,
  shipwayTrackingSyncSettings,
  startShipwayTrackingSync,
  stopShipwayTrackingSync,
} from "../services/shipwayTrackingSyncService.js";
import { getShipwayOrderTracking, refreshShipwayOrderTracking } from "../controllers/logisticsController.js";
import logisticsRoutes from "../routes/logisticsRoutes.js";
import { requireAuth } from "../middleware/auth.js";

Object.assign(process.env, {
  SHIPWAY_EMAIL: "merchant@example.test",
  SHIPWAY_LICENSE_KEY: "test-license",
  SHIPWAY_WAREHOUSE_ID: "109177",
  SHIPWAY_RETURN_WAREHOUSE_ID: "109177",
});
const BASIC_AUTH = Buffer.from("merchant@example.test:test-license").toString("base64");
const SECRETS = ["test-license", "merchant@example.test", BASIC_AUTH, "9876543210", "asha@example.test", "12 Lake Road"];
const NOW = "2026-10-11 12:00:00";
const SYNC_ENV = { SHIPWAY_TRACKING_SYNC_PACE_MS: "0", SHIPWAY_TRACKING_SYNC_BATCH: "25" };
const noSleep = async () => {};

/* ---------- Fixtures ---------- */

const scan = (status, datetime, extra = {}) => ({ status, datetime, location: "Bengaluru Hub", remark: `${status} scan`, ...extra });
const order = (orderId, overrides = {}) => ({
  order_id: orderId,
  awb: "SW900873",
  carrier_id: "3411",
  carrier_title: "Delhivery Surface",
  shipment_status: "INT",
  shipment_status_name: "In Transit",
  shipment_status_time: "2026-10-08 10:00:00",
  // Customer data Shipway returns that must never be logged or stored unredacted.
  customer_name: "Asha Rao",
  phone: "9876543210",
  email: "asha@example.test",
  address: "12 Lake Road",
  shipment_status_scan: [
    scan("SCH", "2026-10-07 09:00:00"),
    scan("INT", "2026-10-08 10:00:00"),
  ],
  ...overrides,
});
const ok = (records) => ({ status: 200, body: { success: 1, error: "", message: records } });

/* ---------- In-memory stand-in for the statements the Shipway tracking code issues ---------- */

function createFakeDb({ orders = [], shipments = [], history = [] } = {}) {
  const db = {
    orders: new Map(orders.map((row) => [row.id, { ...row }])),
    shipments: new Map(shipments.map((row) => [row.id, { ...row }])),
    history: history.map((row) => ({ ...row })),
    audit: [],
    statements: [],
  };
  const rowsOf = (list) => ({ rows: list.map((row) => ({ ...row })), rowCount: list.length });
  const isShipway = (row) => String(row.provider ?? "").trim().toLowerCase() === "shipway";

  db.query = async (rawSql, params = []) => {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    db.statements.push({ sql, params });
    if (/v2orders/i.test(sql)) throw new Error("booking SQL must never run");
    if (/^SELECT s\.\*, o\.order_number AS shipway_order_number FROM shipments s JOIN orders o/i.test(sql)) {
      const limit = Number(sql.match(/LIMIT (\d+)$/)[1]);
      const due = [...db.shipments.values()].filter((row) => isShipway(row) && row.waybill_number &&
        !["delivered", "cancelled", "returned"].includes(row.fulfillment_status) &&
        (!row.last_tracking_update || row.last_tracking_update < "2026-10-11 11:50:00"));
      return rowsOf(due.slice(0, limit).map((row) => ({ ...row, shipway_order_number: db.orders.get(row.order_id)?.order_number })));
    }
    if (/^SELECT id, order_number FROM orders WHERE id = \?/i.test(sql)) return rowsOf([db.orders.get(Number(params[0]))].filter(Boolean));
    if (/^SELECT \* FROM orders WHERE id = \?/i.test(sql)) return rowsOf([db.orders.get(Number(params[0]))].filter(Boolean));
    if (/^SELECT \* FROM shipments WHERE order_id = \? AND sequence_no = 1/i.test(sql)) {
      return rowsOf([...db.shipments.values()].filter((row) => row.order_id === Number(params[0])).slice(0, 1));
    }
    if (/^SELECT \* FROM shipments WHERE id = \?/i.test(sql)) return rowsOf([db.shipments.get(Number(params[0]))].filter(Boolean));
    if (/^SELECT \* FROM shipment_tracking_history WHERE shipment_id=\?/i.test(sql)) {
      return rowsOf(db.history.filter((row) => row.shipment_id === params[0]));
    }
    if (/^INSERT IGNORE INTO shipment_tracking_history/i.test(sql)) {
      const [shipmentId, eventKey, source, status, statusCode, fulfillment, location, instructions, eventTime, raw] = params;
      if (db.history.some((row) => row.shipment_id === shipmentId && row.event_key === eventKey)) return { rows: [], rowCount: 0 };
      db.history.push({ shipment_id: shipmentId, event_key: eventKey, event_source: source, status, status_code: statusCode, fulfillment_status: fulfillment, location, instructions, event_time: eventTime, raw_event: raw });
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE shipments SET fulfillment_status = \?, shipment_status = \?/i.test(sql)) {
      const [next, status, code, statusAt, location, courier, carrierId, edd, delivered, deliveredAt, response, id, guardAt] = params;
      const row = db.shipments.get(Number(id));
      if (!row || !isShipway(row)) return { rows: [], rowCount: 0 };
      if (row.shipment_status_at && !(guardAt && row.shipment_status_at <= guardAt)) return { rows: [], rowCount: 0 };
      Object.assign(row, {
        fulfillment_status: next, shipment_status: status, shipment_status_code: code,
        shipment_status_at: statusAt ?? row.shipment_status_at, current_location: location ?? row.current_location,
        courier_name: courier ?? row.courier_name, carrier_id: carrierId ?? row.carrier_id,
        expected_delivery_date: edd ?? row.expected_delivery_date,
        delivered_at: delivered === 1 ? row.delivered_at ?? deliveredAt ?? NOW : row.delivered_at,
        tracking_response: response, last_tracking_update: NOW, last_error: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE shipments SET last_tracking_update = NOW\(\), last_error = NULL WHERE id = \?$/i.test(sql)) {
      const row = db.shipments.get(Number(params[0]));
      if (row) Object.assign(row, { last_tracking_update: NOW, last_error: null });
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (/^UPDATE shipments SET last_error = \?, last_error_at = NOW\(\)(, last_tracking_update = NOW\(\))? WHERE id = \?$/i.test(sql)) {
      const row = db.shipments.get(Number(params[1]));
      if (row) Object.assign(row, { last_error: params[0], last_error_at: NOW }, /last_tracking_update/.test(sql) ? { last_tracking_update: NOW } : {});
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (/^UPDATE orders SET fulfillment_status = \? WHERE id = \?$/i.test(sql)) {
      const row = db.orders.get(Number(params[1]));
      if (row) row.fulfillment_status = params[0];
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (/^INSERT INTO shipment_audit_log/i.test(sql)) { db.audit.push({ shipmentId: params[0], action: params[2] }); return { rows: [], rowCount: 1 }; }
    throw new Error(`Fake DB received unexpected SQL: ${sql}`);
  };
  return db;
}

const shipwayShipment = (overrides = {}) => ({
  id: 1, order_id: 873, sequence_no: 1, environment: "production", provider: "Shipway",
  courier_name: "Delhivery Surface", carrier_id: "3411", waybill_number: "SW900873",
  fulfillment_status: "ready_to_ship", shipment_status: "Ready to Ship", shipment_status_code: null,
  shipment_status_at: null, current_location: null, last_tracking_update: null, delivered_at: null,
  processing_token: null, created_at: "2026-10-06 09:00:00", ...overrides,
});
const delhiveryShipment = (overrides = {}) => ({
  id: 50, order_id: 900, sequence_no: 1, environment: "production", provider: "Delhivery",
  courier_name: "Delhivery", waybill_number: "DLV12345678", fulfillment_status: "in_transit",
  shipment_status: "In Transit", shipment_status_at: null, last_tracking_update: null, created_at: "2026-10-06 09:00:00", ...overrides,
});
const ordersFor = (...ids) => ids.map((id) => ({ id, order_number: `TAQ-${String(id).padStart(6, "0")}`, fulfillment_status: "ready_to_ship" }));

/** Route fetch to scripted responses keyed by orderid; every request must be GET getorders. */
async function withFetch(responder, body) {
  const saved = { fetch: globalThis.fetch, log: console.log, warn: console.warn, info: console.info, error: console.error };
  const calls = [];
  const logs = [];
  globalThis.fetch = async (url, request = {}) => {
    const href = String(url);
    calls.push({ url: href, method: request.method || "GET", headers: request.headers });
    assert.match(href, /^https:\/\/app\.shipway\.com\/api\/getorders\?/, "tracking must only call GET getorders");
    assert.doesNotMatch(href, /v2orders/);
    assert.equal(request.method || "GET", "GET");
    const parsed = new URL(href);
    const reply = await responder(parsed.searchParams.get("orderid") || parsed.searchParams.get("awb_number"), request);
    if (reply instanceof Response) return reply;
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status || 200 });
  };
  for (const level of ["log", "warn", "info", "error"]) console[level] = (...args) => logs.push(args);
  try {
    await body({ calls, logs });
  } finally {
    globalThis.fetch = saved.fetch;
    Object.assign(console, { log: saved.log, warn: saved.warn, info: saved.info, error: saved.error });
  }
}

const assertNoSecrets = (value) => {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `must not contain ${secret}`);
};

/* ---------- Status mapping ---------- */

test("Shipway status codes map to the documented labels and fulfillment states", () => {
  const expected = {
    SCH: ["Shipment Booked", "shipment_created"], INT: ["In Transit", "in_transit"],
    OOD: ["Out for Delivery", "out_for_delivery"], DEL: ["Delivered", "delivered"],
    UND: ["Undelivered", "ndr"], RTO: ["Return to Origin", "rto"], RTD: ["Returned", "returned"],
    CAN: ["Cancelled", "cancelled"], ONH: ["On Hold", null],
  };
  assert.deepEqual(Object.keys(SHIPWAY_STATUS_MAP).sort(), Object.keys(expected).sort());
  for (const [code, [label, fulfillment]] of Object.entries(expected)) {
    const mapped = mapShipwayStatus(code);
    assert.equal(mapped.label, label);
    assert.equal(mapped.fulfillmentStatus, fulfillment);
    assert.equal(mapShipwayStatus(code.toLowerCase()).code, code);
  }
});

test("unknown Shipway codes are preserved and never mapped to a fulfillment state", () => {
  assert.deepEqual(mapShipwayStatus("PKP", "Picked Up By Courier"), { code: "PKP", label: "Picked Up By Courier", fulfillmentStatus: null, known: false });
  assert.deepEqual(mapShipwayStatus("XYZ"), { code: "XYZ", label: "XYZ", fulfillmentStatus: null, known: false });
  assert.equal(mapShipwayStatus(null, "Delivered").fulfillmentStatus, "delivered");
  const parsed = parseShipwayTrackingRecord({ order_id: "A1", shipment_status: "LST", shipment_status_name: "Lost" });
  assert.equal(parsed.statusCode, "LST");
  assert.equal(parsed.statusLabel, "Lost");
  assert.equal(parsed.fulfillmentStatus, null);
});

const MAPPED_CODES = ["DEL", "INT", "UND", "RTO", "RTD", "CAN", "SCH", "ONH", "OOD"];
// Documented Shipway codes without an agreed fulfillment equivalent (NFI/NFIDS, reschedules,
// reverse-pickup R*, PCAN, ROTH, RPF). They must be preserved verbatim, never guessed.
const PRESERVED_CODES = ["NFI", "NFIDS", "RSCH", "ROOP", "RPKP", "RDEL", "RINT", "RPSH", "RCAN", "RCLO", "RSMD", "PCAN", "ROTH", "RPF"];

test("parser recognises every documented Shipway status code at record and event level", () => {
  for (const code of [...MAPPED_CODES, ...PRESERVED_CODES]) {
    const record = parseShipwayTrackingRecord({ order_id: "A", shipment_status: code, shipment_status_scan: [scan(code, "2026-10-08 10:00:00")] });
    assert.equal(record.statusCode, code, `record code ${code}`);
    assert.equal(record.events[0].statusCode, code, `event code ${code}`);
    const mapped = MAPPED_CODES.includes(code);
    assert.equal(mapShipwayStatus(code).known, mapped, `${code} known`);
    assert.equal(record.fulfillmentStatus, SHIPWAY_STATUS_MAP[code]?.fulfillmentStatus ?? null, `${code} fulfillment`);
    assert.ok(record.statusLabel, `${code} has a label`);
  }
});

test("a preserved status code is stored verbatim without changing fulfillment", async () => {
  for (const code of PRESERVED_CODES) {
    const db = createFakeDb({ orders: ordersFor(873), shipments: [shipwayShipment({ fulfillment_status: "in_transit", shipment_status_code: "INT", shipment_status_at: "2026-10-08 10:00:00" })] });
    await withFetch(() => ok([order("TAQ-000873", { shipment_status: code, shipment_status_name: `Status ${code}`, shipment_status_time: "2026-10-09 10:00:00" })]), async () => {
      await refreshShipwayShipment(db.shipments.get(1), { db });
    });
    const row = db.shipments.get(1);
    assert.equal(row.shipment_status_code, code);
    assert.equal(row.shipment_status, `Status ${code}`);
    assert.equal(row.fulfillment_status, "in_transit", `${code} must not change fulfillment`);
    assert.equal(db.orders.get(873).fulfillment_status, "ready_to_ship");
  }
});

test("empty or malformed responses never erase existing tracking data", async () => {
  const bodies = ["", "   ", "null", "{}", "[]", "<html>502</html>", "{bad json",
    JSON.stringify({ success: 1, message: "No order found" }),
    JSON.stringify({ success: 1, message: [] }),
    JSON.stringify({ success: 1, message: [{}] }),
    JSON.stringify({ success: 1, message: [{ order_id: "TAQ-000873" }] }),
    JSON.stringify({ success: 1, message: [{ order_id: "TAQ-000873", awb: "", shipment_status: "", shipment_status_scan: [] }] }),
    JSON.stringify({ success: 0, message: "Something went wrong" }),
    JSON.stringify({ success: 1, message: 42 })];
  const tracked = shipwayShipment({
    fulfillment_status: "out_for_delivery", shipment_status: "Out for Delivery", shipment_status_code: "OOD",
    shipment_status_at: "2026-10-09 08:00:00", current_location: "Mysuru", tracking_response: "{\"kept\":true}",
  });
  const history = [{ shipment_id: 1, event_key: "k1", status: "In Transit" }, { shipment_id: 1, event_key: "k2", status: "Out for Delivery" }];
  const durable = ["provider", "waybill_number", "courier_name", "carrier_id", "fulfillment_status", "shipment_status", "shipment_status_code", "shipment_status_at", "current_location", "tracking_response", "delivered_at"];
  for (const body of bodies) {
    const db = createFakeDb({ orders: ordersFor(873), shipments: [tracked], history });
    await withFetch(() => ({ status: 200, body }), async () => {
      await runShipwayTrackingSync({ db, env: SYNC_ENV, sleepFn: noSleep });
      await callHandler(refreshShipwayOrderTracking, { params: { orderId: "873" } }, db);
    });
    const row = db.shipments.get(1);
    for (const column of durable) assert.deepEqual(row[column], tracked[column], `${column} changed for body ${body}`);
    assert.deepEqual(db.history, history, `history changed for body ${body}`);
    assert.equal(db.orders.get(873).fulfillment_status, "ready_to_ship");
    assert.ok(db.statements.every((s) => !/^(DELETE|TRUNCATE)\b/i.test(s.sql)), "no deletes may be issued");
  }
});

/* ---------- Parser variations ---------- */

test("parser reads the getorders message[] shape with scans, carrier and timestamps", () => {
  const result = parseShipwayTrackingResponse(ok([order("TAQ-000873")]).body, { orderNumber: "TAQ-000873" });
  assert.equal(result.state, "found");
  const t = result.tracking;
  assert.equal(t.awb, "SW900873");
  assert.equal(t.carrierId, "3411");
  assert.equal(t.carrierName, "Delhivery Surface");
  assert.equal(t.statusCode, "INT");
  assert.equal(t.statusLabel, "In Transit");
  assert.equal(t.fulfillmentStatus, "in_transit");
  assert.equal(t.statusAt, "2026-10-08 10:00:00");
  assert.equal(t.events.length, 2);
  assert.deepEqual(t.events.map((event) => event.statusCode), ["SCH", "INT"]);
  assert.equal(t.events[1].location, "Bengaluru Hub");
  assert.equal(t.events[1].activity, "INT scan");
  assertNoSecrets(t.events.map((event) => event.raw));
});

test("parser handles a bare array, nested shipment details, date+time split and alternate keys", () => {
  const body = [{
    orderid: "TAQ-000874",
    shipment_details: { awbno: "AWB874", courier_name: "Bluedart", current_status: "OOD" },
    scans: [
      { status_code: "OOD", status_name: "Out for Delivery", date: "09-10-2026", time: "08:15", city: "Mysuru", activity: "With delivery agent" },
      { code: "INT", date_time: "2026-10-08T22:00:00Z", scan_location: "Hub" },
    ],
  }];
  const t = parseShipwayTrackingResponse(body, { orderNumber: "TAQ-000874" }).tracking;
  assert.equal(t.awb, "AWB874");
  assert.equal(t.carrierName, "Bluedart");
  assert.equal(t.statusCode, "OOD");
  assert.equal(t.fulfillmentStatus, "out_for_delivery");
  assert.deepEqual(t.events.map((event) => event.eventTime), ["2026-10-08 22:00:00", "2026-10-09 08:15:00"]);
  assert.equal(t.statusAt, "2026-10-09 08:15:00");
  assert.equal(t.location, "Mysuru");
});

test("parser falls back to the latest event when the record has no top-level status", () => {
  const t = parseShipwayTrackingRecord({ order_id: "A", carrier: 77, tracking_history: [scan("INT", "2026-10-08 10:00:00"), scan("DEL", "2026-10-10 16:30:00")] });
  assert.equal(t.statusCode, "DEL");
  assert.equal(t.fulfillmentStatus, "delivered");
  assert.equal(t.statusAt, "2026-10-10 16:30:00");
  assert.equal(t.carrierId, "77");
  assert.equal(t.carrierName, null);
  assert.equal(t.awb, null);
});

test("timestamp normaliser keeps wall-clock values and rejects garbage", () => {
  assert.equal(normalizeShipwayTime("2026-10-08 10:00"), "2026-10-08 10:00:00");
  assert.equal(normalizeShipwayTime("08/10/2026 10:00:05"), "2026-10-08 10:00:05");
  assert.equal(normalizeShipwayTime(1791460800), "2026-10-08 12:00:00");
  assert.equal(normalizeShipwayTime("not a date"), null);
  assert.equal(normalizeShipwayTime(""), null);
  assert.equal(normalizeShipwayTime({}), null);
});

test("parser reports not-found for no order, empty lists and other orders", () => {
  assert.equal(parseShipwayTrackingResponse({ success: 1, message: "No order found" }, { orderNumber: "X" }).state, "not_found");
  assert.equal(parseShipwayTrackingResponse({ success: 1, message: [] }, { orderNumber: "X" }).state, "not_found");
  assert.equal(parseShipwayTrackingResponse([], { orderNumber: "X" }).state, "not_found");
  assert.equal(parseShipwayTrackingResponse(ok([order("TAQ-999999", { awb: "OTHER" })]).body, { orderNumber: "TAQ-000873", awb: "SW900873" }).state, "not_found");
  // Matched by AWB when the order id differs in formatting.
  assert.equal(parseShipwayTrackingResponse(ok([order("taq-000873")]).body, { orderNumber: "TAQ-000873" }).state, "found");
});

test("parser rejects malformed and empty bodies", () => {
  for (const body of [null, {}, { success: 1, message: 42 }, "text", [null, 5], [{ order_id: "X" }]]) {
    assert.throws(() => parseShipwayTrackingResponse(body, { orderNumber: "X" }), { code: "SHIPWAY_TRACKING_INVALID_RESPONSE" });
  }
  assert.throws(() => parseShipwayTrackingResponse({ success: 0, message: "Invalid license key" }, { orderNumber: "X" }), { code: "SHIPWAY_TRACKING_AUTH" });
});

/* ---------- HTTP lookup ---------- */

test("getShipwayTracking uses GET getorders with the existing Basic auth and supports AWB-only lookup", async () => {
  await withFetch(() => ok([order("TAQ-000873")]), async ({ calls }) => {
    const result = await getShipwayTracking({ orderNumber: "TAQ-000873", awb: "SW900873" });
    assert.equal(result.state, "found");
    assert.equal(calls[0].headers.Authorization, `Basic ${BASIC_AUTH}`);
    assertNoSecrets(result.body);
    const byAwb = await getShipwayTracking({ awb: "SW900873" });
    assert.equal(byAwb.state, "found");

    const params = calls.map((call) => Object.fromEntries(new URL(call.url).searchParams));
    // Order-number lookups use the documented orderid parameter only.
    assert.deepEqual(params[0], { orderid: "TAQ-000873" });
    // AWB-only lookups use the documented awb_number parameter, never the unsupported awb.
    assert.deepEqual(params[1], { awb_number: "SW900873" });
    for (const call of calls) assert.doesNotMatch(call.url, /[?&]awb=/);
  });
  await assert.rejects(() => getShipwayTracking({}), { code: "SHIPWAY_TRACKING_NO_IDENTIFIER" });
});

test("getShipwayTracking classifies 401, 403, 404, 429, 5xx, malformed and empty responses", async () => {
  const cases = [
    [{ status: 401, body: { message: "Unauthorized" } }, { code: "SHIPWAY_TRACKING_AUTH", stopBatch: true }],
    [{ status: 403, body: "" }, { code: "SHIPWAY_TRACKING_AUTH", stopBatch: true }],
    [{ status: 429, body: "" }, { code: "SHIPWAY_TRACKING_RATE_LIMITED", stopBatch: true }],
    [{ status: 500, body: "<html>oops</html>" }, { code: "SHIPWAY_TRACKING_UPSTREAM", retryable: true }],
    [{ status: 503, body: "" }, { code: "SHIPWAY_TRACKING_UPSTREAM", retryable: true }],
    [{ status: 200, body: "{not json" }, { code: "SHIPWAY_TRACKING_INVALID_RESPONSE" }],
    [{ status: 200, body: "" }, { code: "SHIPWAY_TRACKING_INVALID_RESPONSE" }],
  ];
  for (const [reply, expected] of cases) {
    await withFetch(() => reply, async () => {
      await assert.rejects(() => getShipwayTracking({ orderNumber: "TAQ-000873" }), expected);
    });
  }
  await withFetch(() => ({ status: 404, body: { message: "Not Found" } }), async () => {
    assert.equal((await getShipwayTracking({ orderNumber: "TAQ-000873" })).state, "not_found");
  });
  await withFetch(() => { throw new TypeError("fetch failed"); }, async () => {
    await assert.rejects(() => getShipwayTracking({ orderNumber: "TAQ-000873" }), { code: "SHIPWAY_TRACKING_NETWORK" });
  });
});

test("getShipwayTracking aborts on timeout", async () => {
  const hang = (_id, request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  await withFetch(hang, async () => {
    await assert.rejects(() => getShipwayTracking({ orderNumber: "TAQ-000873" }, { timeoutMs: 20 }), { code: "SHIPWAY_TRACKING_TIMEOUT", retryable: true });
  });
});

/* ---------- Persistence ---------- */

test("refresh updates the shipment, order and history from Shipway", async () => {
  const db = createFakeDb({ orders: ordersFor(873), shipments: [shipwayShipment()] });
  await withFetch(() => ok([order("TAQ-000873")]), async () => {
    const result = await refreshShipwayShipment(db.shipments.get(1), { db });
    assert.equal(result.applied, true);
    assert.equal(result.events_added, 2);
  });
  const row = db.shipments.get(1);
  assert.equal(row.fulfillment_status, "in_transit");
  assert.equal(row.shipment_status, "In Transit");
  assert.equal(row.shipment_status_code, "INT");
  assert.equal(row.shipment_status_at, "2026-10-08 10:00:00");
  assert.equal(row.provider, "Shipway");
  assert.equal(db.orders.get(873).fulfillment_status, "in_transit");
  assert.ok(db.history.every((event) => event.event_source === "shipway_tracking" && /^[0-9a-f]{64}$/.test(event.event_key)));
  assertNoSecrets(row.tracking_response);
  assertNoSecrets(db.history);
});

test("duplicate events are not inserted twice and keys are deterministic", async () => {
  const db = createFakeDb({ orders: ordersFor(873), shipments: [shipwayShipment()] });
  await withFetch(() => ok([order("TAQ-000873")]), async () => {
    await refreshShipwayShipment(db.shipments.get(1), { db });
    const second = await refreshShipwayShipment(db.shipments.get(1), { db });
    assert.equal(second.events_added, 0);
  });
  assert.equal(db.history.length, 2);
  const event = { statusCode: "INT", status: "In Transit", eventTime: "2026-10-08 10:00:00", location: "Hub", activity: "x" };
  assert.equal(shipwayEventKey(event), shipwayEventKey({ ...event }));
  assert.notEqual(shipwayEventKey(event), shipwayEventKey({ ...event, eventTime: "2026-10-08 10:00:01" }));
});

test("an older Shipway event never replaces a newer stored shipment state", async () => {
  const db = createFakeDb({
    orders: ordersFor(873),
    shipments: [shipwayShipment({ fulfillment_status: "out_for_delivery", shipment_status: "Out for Delivery", shipment_status_code: "OOD", shipment_status_at: "2026-10-09 08:00:00" })],
  });
  await withFetch(() => ok([order("TAQ-000873")]), async () => {
    const result = await refreshShipwayShipment(db.shipments.get(1), { db });
    assert.equal(result.applied, false);
    assert.equal(result.stale_ignored, true);
    assert.equal(result.events_added, 2, "older events are still recorded in history");
  });
  const row = db.shipments.get(1);
  assert.equal(row.fulfillment_status, "out_for_delivery");
  assert.equal(row.shipment_status_code, "OOD");
  assert.equal(row.shipment_status_at, "2026-10-09 08:00:00");
  assert.equal(db.orders.get(873).fulfillment_status, "ready_to_ship");

  // Without a timestamp, a response cannot override a timestamped state either.
  await withFetch(() => ok([order("TAQ-000873", { shipment_status: "INT", shipment_status_time: null, shipment_status_scan: [] })]), async () => {
    assert.equal((await refreshShipwayShipment(db.shipments.get(1), { db })).applied, false);
  });
  assert.equal(db.shipments.get(1).shipment_status_code, "OOD");
});

test("a delivered shipment is never regressed by a newer non-terminal event", async () => {
  const db = createFakeDb({ orders: ordersFor(873), shipments: [shipwayShipment({ fulfillment_status: "delivered", shipment_status_code: "DEL", shipment_status_at: "2026-10-09 08:00:00" })] });
  await withFetch(() => ok([order("TAQ-000873", { shipment_status_time: "2026-10-10 10:00:00" })]), async () => {
    assert.equal((await refreshShipwayShipment(db.shipments.get(1), { db })).applied, false);
  });
  assert.equal(db.shipments.get(1).fulfillment_status, "delivered");
});

test("a response missing AWB and carrier keeps the stored AWB, carrier and provider", async () => {
  const db = createFakeDb({ orders: ordersFor(873), shipments: [shipwayShipment()] });
  const sparse = { order_id: "TAQ-000873", awb: "", carrier_title: null, shipment_status: "OOD", shipment_status_time: "2026-10-09 08:00:00" };
  await withFetch(() => ok([sparse]), async () => {
    assert.equal((await refreshShipwayShipment(db.shipments.get(1), { db })).applied, true);
  });
  const row = db.shipments.get(1);
  assert.equal(row.waybill_number, "SW900873");
  assert.equal(row.courier_name, "Delhivery Surface");
  assert.equal(row.carrier_id, "3411");
  assert.equal(row.provider, "Shipway");
  assert.equal(row.fulfillment_status, "out_for_delivery");
});

test("a Shipway shipment without an AWB is not tracked and Shipway is not called", async () => {
  const db = createFakeDb({ orders: ordersFor(873), shipments: [shipwayShipment({ waybill_number: null })] });
  await withFetch(() => { throw new Error("must not be called"); }, async ({ calls }) => {
    await assert.rejects(() => refreshShipwayShipment(db.shipments.get(1), { db }), { code: "SHIPWAY_TRACKING_NO_AWB" });
    const summary = await runShipwayTrackingSync({ db, env: SYNC_ENV, sleepFn: noSleep });
    assert.equal(summary.attempted, 0);
    assert.equal(calls.length, 0);
  });
});

/* ---------- Worker ---------- */

test("worker processes multiple Shipway shipments and continues after one fails", async () => {
  const db = createFakeDb({
    orders: ordersFor(873, 874, 875),
    shipments: [
      shipwayShipment({ id: 1, order_id: 873, waybill_number: "SW873" }),
      shipwayShipment({ id: 2, order_id: 874, waybill_number: "SW874", shipment_status_at: "2026-10-01 00:00:00", current_location: "Old Hub" }),
      shipwayShipment({ id: 3, order_id: 875, waybill_number: "SW875" }),
    ],
  });
  await withFetch((orderId) => (orderId === "TAQ-000874"
    ? { status: 500, body: "" }
    : ok([order(orderId, { awb: `SW${orderId.slice(-3)}`, shipment_status: "DEL", shipment_status_time: "2026-10-10 12:00:00" })])), async ({ calls }) => {
    const summary = await runShipwayTrackingSync({ db, env: SYNC_ENV, sleepFn: noSleep });
    assert.deepEqual({ attempted: summary.attempted, updated: summary.updated, failed: summary.failed }, { attempted: 3, updated: 2, failed: 1 });
    assert.equal(calls.length, 3);
  });
  assert.equal(db.shipments.get(1).fulfillment_status, "delivered");
  assert.equal(db.shipments.get(3).fulfillment_status, "delivered");
  const failed = db.shipments.get(2);
  assert.equal(failed.fulfillment_status, "ready_to_ship", "failure must not change status");
  assert.equal(failed.shipment_status_at, "2026-10-01 00:00:00");
  assert.equal(failed.current_location, "Old Hub");
  assert.equal(failed.waybill_number, "SW874");
  assert.match(failed.last_error, /HTTP 500/);
});

test("worker never processes Delhivery shipments, even if the query returned one", async () => {
  const db = createFakeDb({ orders: ordersFor(873, 900), shipments: [shipwayShipment(), delhiveryShipment(), delhiveryShipment({ id: 51, order_id: 901, provider: null })] });
  await withFetch((orderId) => ok([order(orderId)]), async ({ calls }) => {
    const summary = await runShipwayTrackingSync({ db, env: SYNC_ENV, sleepFn: noSleep });
    assert.equal(summary.attempted, 1);
    assert.deepEqual(calls.map((call) => new URL(call.url).searchParams.get("orderid")), ["TAQ-000873"]);
  });
  assert.equal(db.shipments.get(50).last_tracking_update, null);
  assert.equal(db.shipments.get(51).last_tracking_update, null);
  const select = db.statements.find((s) => /^SELECT s\.\*/.test(s.sql));
  assert.match(select.sql, /WHERE LOWER\(TRIM\(s\.provider\)\) = 'shipway'/);
  const update = db.statements.find((s) => /^UPDATE shipments SET fulfillment_status/.test(s.sql));
  assert.match(update.sql, /AND LOWER\(TRIM\(provider\)\) = 'shipway'/);
  assert.ok(db.statements.every((s) => !s.params.includes(50) && !s.params.includes(51)), "Delhivery rows must not be written");

  // Defence in depth: rows that slip through the SQL filter are still skipped.
  const leaky = createFakeDb({ orders: ordersFor(900), shipments: [delhiveryShipment()] });
  const query = leaky.query;
  leaky.query = (sql, params) => (/^\s*SELECT s\.\*/.test(sql) ? { rows: [{ ...leaky.shipments.get(50) }], rowCount: 1 } : query(sql, params));
  await withFetch(() => { throw new Error("must not be called"); }, async ({ calls }) => {
    assert.equal((await runShipwayTrackingSync({ db: leaky, env: SYNC_ENV, sleepFn: noSleep })).attempted, 0);
    await assert.rejects(() => refreshShipwayShipment(delhiveryShipment(), { db: leaky }), { code: "SHIPWAY_TRACKING_NOT_SHIPWAY" });
    assert.equal(calls.length, 0);
  });
});

test("worker pauses the batch on auth failure or 429 without deleting data", async () => {
  for (const status of [401, 403, 429]) {
    const db = createFakeDb({ orders: ordersFor(873, 874), shipments: [shipwayShipment({ id: 1, order_id: 873, shipment_status_code: "INT", shipment_status_at: "2026-10-08 10:00:00" }), shipwayShipment({ id: 2, order_id: 874 })] });
    await withFetch(() => ({ status, body: "" }), async ({ calls }) => {
      const summary = await runShipwayTrackingSync({ db, env: SYNC_ENV, sleepFn: noSleep });
      assert.equal(calls.length, 1, `HTTP ${status} must stop the batch`);
      assert.ok(summary.stopped);
    });
    const row = db.shipments.get(1);
    assert.equal(row.shipment_status_code, "INT");
    assert.equal(row.waybill_number, "SW900873");
    assert.ok(row.last_error);
    assert.equal(db.history.length, 0);
  }
});

test("worker treats timeout, malformed, empty and not-found responses as per-shipment failures", async () => {
  const replies = [{ status: 200, body: "{bad" }, { status: 200, body: "" }, ok([]), { status: 404, body: "" }];
  const db = createFakeDb({
    orders: ordersFor(1, 2, 3, 4),
    shipments: [1, 2, 3, 4].map((id) => shipwayShipment({ id, order_id: id, waybill_number: `SW${id}`, shipment_status_code: "INT", shipment_status_at: "2026-10-08 10:00:00" })),
    history: [{ shipment_id: 1, event_key: "k", status: "In Transit" }],
  });
  await withFetch(() => replies.shift(), async ({ calls }) => {
    const summary = await runShipwayTrackingSync({ db, env: SYNC_ENV, sleepFn: noSleep });
    assert.equal(calls.length, 4);
    assert.equal(summary.failed, 4);
    assert.equal(summary.stopped, null);
  });
  for (const row of db.shipments.values()) {
    assert.equal(row.shipment_status_code, "INT");
    assert.ok(row.last_error);
  }
  assert.equal(db.history.length, 1, "existing history is never removed");

  const timeoutDb = createFakeDb({ orders: ordersFor(873), shipments: [shipwayShipment()] });
  const fetchTracking = (ids) => getShipwayTracking(ids, { timeoutMs: 10 });
  await withFetch((_id, request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }), async () => {
    const summary = await runShipwayTrackingSync({ db: timeoutDb, env: SYNC_ENV, sleepFn: noSleep, fetchTracking });
    assert.equal(summary.failed, 1);
  });
  assert.match(timeoutDb.shipments.get(1).last_error, /timed out/);
  assert.equal(timeoutDb.shipments.get(1).fulfillment_status, "ready_to_ship");
});

test("worker runs never overlap", async () => {
  const db = createFakeDb({ orders: ordersFor(873), shipments: [shipwayShipment()] });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let fetches = 0;
  const fetchTracking = async () => { fetches += 1; await gate; return { state: "not_found" }; };
  const first = runShipwayTrackingSync({ db, env: SYNC_ENV, sleepFn: noSleep, fetchTracking });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await runShipwayTrackingSync({ db, env: SYNC_ENV, sleepFn: noSleep, fetchTracking });
  assert.deepEqual(second, { skipped: true, reason: "already_running" });
  release();
  const done = await first;
  assert.equal(done.attempted, 1);
  assert.equal(fetches, 1);
  // The lock is released afterwards.
  assert.equal((await runShipwayTrackingSync({ db: createFakeDb(), env: SYNC_ENV, sleepFn: noSleep, fetchTracking })).skipped, false);
});

test("worker is disabled unless SHIPWAY_TRACKING_SYNC_ENABLED=true and reads its settings", () => {
  for (const value of [undefined, "", "false", "1", "yes"]) {
    assert.equal(isShipwayTrackingSyncEnabled({ SHIPWAY_TRACKING_SYNC_ENABLED: value }), false);
    assert.equal(startShipwayTrackingSync({ SHIPWAY_TRACKING_SYNC_ENABLED: value }), null);
  }
  const timer = startShipwayTrackingSync({ SHIPWAY_TRACKING_SYNC_ENABLED: "TRUE", SHIPWAY_TRACKING_SYNC_MINUTES: "15" });
  assert.ok(timer);
  stopShipwayTrackingSync();
  assert.deepEqual(shipwayTrackingSyncSettings({}), { minutes: 30, batch: 25, paceMs: 1000 });
  assert.deepEqual(shipwayTrackingSyncSettings({ SHIPWAY_TRACKING_SYNC_MINUTES: "1", SHIPWAY_TRACKING_SYNC_BATCH: "500", SHIPWAY_TRACKING_SYNC_PACE_MS: "99999" }), { minutes: 5, batch: 100, paceMs: 10000 });
  assert.deepEqual(shipwayTrackingSyncSettings({ SHIPWAY_TRACKING_SYNC_BATCH: "abc", SHIPWAY_TRACKING_SYNC_PACE_MS: "-1" }), { minutes: 30, batch: 25, paceMs: 1000 });
});

test("worker paces requests between shipments", async () => {
  const db = createFakeDb({ orders: ordersFor(1, 2, 3), shipments: [1, 2, 3].map((id) => shipwayShipment({ id, order_id: id, waybill_number: `SW${id}` })) });
  const sleeps = [];
  await runShipwayTrackingSync({ db, env: { SHIPWAY_TRACKING_SYNC_PACE_MS: "250" }, sleepFn: async (ms) => sleeps.push(ms), fetchTracking: async () => ({ state: "not_found" }) });
  assert.deepEqual(sleeps, [250, 250]);
});

/* ---------- Safe logging ---------- */

test("logs never contain credentials, auth headers or customer data", async () => {
  const db = createFakeDb({ orders: ordersFor(873, 874), shipments: [shipwayShipment(), shipwayShipment({ id: 2, order_id: 874, waybill_number: "SW874" })] });
  const replies = [ok([order("TAQ-000873")]), { status: 500, body: { message: "error for 9876543210 at 12 Lake Road", email: "asha@example.test" } }];
  await withFetch(() => replies.shift(), async ({ logs }) => {
    await runShipwayTrackingSync({ db, env: SYNC_ENV, sleepFn: noSleep });
    assert.ok(logs.length > 0);
    assertNoSecrets(logs);
  });
  await withFetch(() => ({ status: 401, body: "" }), async ({ logs }) => {
    const res = await callHandler(refreshShipwayOrderTracking, { params: { orderId: "873" } }, db);
    assert.equal(res.statusCode, 502);
    assertNoSecrets(logs);
    assertNoSecrets(res.body);
  });
});

/* ---------- Controller + routes ---------- */

function mockRes() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
}

async function callHandler(handler, req, db) {
  const saved = pool.query;
  pool.query = db.query;
  try {
    const res = mockRes();
    await handler({ user: { admin_id: 7 }, body: {}, query: {}, ...req }, res);
    return res;
  } finally {
    pool.query = saved;
  }
}

test("admin refresh endpoint updates Shipway tracking and returns history", async () => {
  const db = createFakeDb({ orders: ordersFor(873), shipments: [shipwayShipment()] });
  await withFetch(() => ok([order("TAQ-000873")]), async ({ calls }) => {
    const res = await callHandler(refreshShipwayOrderTracking, { params: { orderId: "873" } }, db);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.fulfillment_status, "in_transit");
    assert.equal(res.body.tracking_history.length, 2);
    assert.equal(calls.length, 1);
  });
  assert.equal(db.audit[0].action, "shipway_tracking_refreshed");
  const view = await callHandler(getShipwayOrderTracking, { params: { orderId: "873" } }, db);
  assert.equal(view.statusCode, 200);
  assert.equal(view.body.shipment_status_code, "INT");
  assert.equal(view.body.waybill, "SW900873");
  assert.equal(view.body.tracking_history.length, 2);
});

test("admin endpoints reject Delhivery orders, missing orders and invalid ids without calling Shipway", async () => {
  const db = createFakeDb({ orders: ordersFor(900), shipments: [delhiveryShipment()] });
  await withFetch(() => { throw new Error("must not be called"); }, async ({ calls }) => {
    assert.equal((await callHandler(refreshShipwayOrderTracking, { params: { orderId: "900" } }, db)).statusCode, 409);
    assert.equal((await callHandler(getShipwayOrderTracking, { params: { orderId: "900" } }, db)).statusCode, 409);
    assert.equal((await callHandler(getShipwayOrderTracking, { params: { orderId: "12345" } }, db)).statusCode, 404);
    assert.equal((await callHandler(refreshShipwayOrderTracking, { params: { orderId: "abc" } }, db)).statusCode, 400);
    assert.equal(calls.length, 0);
  });
  assert.equal(db.shipments.get(50).last_error, undefined);
});

test("admin refresh maps upstream failures and keeps stored tracking", async () => {
  const cases = [[{ status: 429, body: "" }, 429], [{ status: 503, body: "" }, 502], [{ status: 200, body: "{bad" }, 502], [ok([]), 404]];
  for (const [reply, expected] of cases) {
    const db = createFakeDb({ orders: ordersFor(873), shipments: [shipwayShipment({ shipment_status_code: "INT", shipment_status_at: "2026-10-08 10:00:00" })] });
    await withFetch(() => reply, async () => {
      const res = await callHandler(refreshShipwayOrderTracking, { params: { orderId: "873" } }, db);
      assert.equal(res.statusCode, expected);
      assert.equal(res.body.success, false);
    });
    assert.equal(db.shipments.get(1).shipment_status_code, "INT");
    assert.ok(db.shipments.get(1).last_error);
  }
});

test("Shipway tracking routes are registered behind the admin auth middleware", () => {
  const layers = logisticsRoutes.stack;
  assert.equal(layers[0].handle, requireAuth, "requireAuth must run before every logistics route");
  const routes = layers.filter((layer) => layer.route).map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  assert.ok(routes.includes("GET /shipway/orders/:orderId/tracking"));
  assert.ok(routes.includes("POST /shipway/orders/:orderId/tracking/refresh"));
});
