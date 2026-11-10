import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIndiaPostArticle,
  bookIndiaPostArticle,
  codAmountToCollect,
  getIndiaPostConfig,
  getIndiaPostToken,
  getIndiaPostTracking,
  mapIndiaPostStatus,
  missingIndiaPostSettings,
  setIndiaPostFetchForTests,
} from "../services/indiaPostService.js";
import { bookOrderWithIndiaPost, refreshIndiaPostShipment } from "../services/indiaPostShipmentService.js";
import { trackingUrlFor } from "../services/shipmentTrackingNotificationService.js";
import { DELHIVERY_ONLY_SQL, assertDelhiveryManagedShipment } from "../services/shipmentProvider.js";

const ENV = {
  INDIA_POST_BASE_URL: "https://test.cept.gov.in/beextcustomer",
  INDIA_POST_USERNAME: "1372039469",
  INDIA_POST_PASSWORD: "secret",
  INDIA_POST_CUSTOMER_ID: "1372039469",
  INDIA_POST_CONTRACT_ID: "41441234",
  INDIA_POST_DROPOFF_OFFICE_ID: "21260024",
  INDIA_POST_DROPOFF_PINCODE: "500081",
  INDIA_POST_SENDER_ADDRESS: "D4 Myrah Avenue, SBI Colony",
  INDIA_POST_SENDER_CITY: "Hyderabad",
  INDIA_POST_SENDER_STATE: "Telangana",
  INDIA_POST_SENDER_PINCODE: "500081",
  INDIA_POST_SENDER_MOBILE: "8977591115",
};
const config = getIndiaPostConfig(ENV);

const order = {
  id: 1280, order_number: "TAQ-001280", customer_name: "Asha Rao", phone: "+91 98765 43210",
  email: "9876543210@guest.tel-aqua.in", address: "12 Lake Road, near temple", city: "Eluru",
  state: "Andhra Pradesh", pincode: "534001", payment_mode: "cod", payment_status: "Pending",
  final_total: "1799.00", total_amount: "1799.00",
};

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

/** Fake India Post: records calls and answers login / booking / tracking. */
function fakeIndiaPost({ booking, tracking, loginStatus = 200 } = {}) {
  const calls = [];
  setIndiaPostFetchForTests(async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/v1/access/login")) {
      return loginStatus === 200
        ? jsonResponse(200, { success: true, data: { access_token: "TOKEN1", expires_in: 900 } })
        : jsonResponse(401, { success: false, message: "Invalid credentials" });
    }
    if (url.includes("/process-articles-file/")) return jsonResponse(200, booking);
    if (url.includes("/v1/tracking/")) return tracking ? jsonResponse(200, tracking) : jsonResponse(404, { success: false });
    throw new Error(`unexpected url ${url}`);
  });
  return calls;
}

test.afterEach(() => setIndiaPostFetchForTests(null));

test("config: sandbox defaults, booking needs contract + sender details", () => {
  assert.equal(getIndiaPostConfig({}).baseUrl, "https://test.cept.gov.in/beextcustomer");
  assert.deepEqual(missingIndiaPostSettings(getIndiaPostConfig({}), {}), ["INDIA_POST_USERNAME", "INDIA_POST_PASSWORD"]);
  assert.deepEqual(missingIndiaPostSettings(config, { forBooking: true }), []);
  const noContract = getIndiaPostConfig({ ...ENV, INDIA_POST_CONTRACT_ID: "" });
  assert.ok(missingIndiaPostSettings(noContract, { forBooking: true }).includes("INDIA_POST_CONTRACT_ID (numeric)"));
});

test("article: built from the order; COD collects only what is still due", () => {
  const article = buildIndiaPostArticle(order, { config, barcode: "eb468827991in" });
  assert.equal(article.receiver_name, "Asha Rao");
  assert.equal(article.receiver_mobile_no, "9876543210");
  assert.equal(article.receiver_pincode, "534001");
  assert.equal(article.receiver_emailid, undefined, "guest email is not sent");
  assert.equal(article.bulk_customer_id, 1372039469);
  assert.equal(article.contract_id, 41441234);
  assert.equal(article.pickup_dropoff_office_id, 21260024);
  assert.equal(article.article_type, "SP");
  assert.equal(article.physical_weight, 300);
  // Box size goes to India Post in millimetres (20 x 10 x 6 cm).
  assert.equal(article.length, 200);
  assert.equal(article.breadth_diameter, 100);
  assert.equal(article.height, 60);
  assert.equal(article.codr_cod, "COD");
  assert.equal(article.value_for_codr_cod, 1799);
  assert.equal(article.barcode_no, "EB468827991IN");
  assert.equal(article.bulk_reference, "TAQ-001280");
  assert.equal(codAmountToCollect({ ...order, payment_status: "Paid" }), 0);
  assert.equal(codAmountToCollect({ ...order, payment_mode: "razorpay" }), 0);
  assert.equal(codAmountToCollect({ ...order, cod_amount_due: "1799.00" }), 1799);
});

test("login: token is cached and sent as Bearer; bad credentials give a clear error", async () => {
  const calls = fakeIndiaPost({ tracking: { success: true, data: { currentStatus: "Booked", history: [] } } });
  assert.equal(await getIndiaPostToken({ config, force: true }), "TOKEN1");
  await getIndiaPostTracking("EB468827991IN", { config });
  await getIndiaPostTracking("EB468827991IN", { config });
  assert.equal(calls.filter((c) => c.url.endsWith("/login")).length, 1);
  assert.deepEqual(calls[0].body, { username: "1372039469", password: "secret" });
  assert.equal(calls[1].headers.Authorization, "Bearer TOKEN1");

  fakeIndiaPost({ loginStatus: 401 });
  await assert.rejects(() => getIndiaPostToken({ config, force: true }), { code: "INDIA_POST_AUTH_FAILED" });
});

test("booking: valid article returns its article number; rejected article returns India Post's reason", async () => {
  const calls = fakeIndiaPost({ booking: { success: true, batch_id: "b1", valid_articles: [{ barcode_no: "EB468827991IN", calculated_tariff: 41 }], error_articles: [] } });
  const booked = await bookIndiaPostArticle(order, { config });
  assert.equal(booked.barcode, "EB468827991IN");
  assert.equal(booked.tariff, 41);
  const upload = calls.find((c) => c.url.includes("/process-articles-file/"));
  assert.equal(upload.url, "https://test.cept.gov.in/beextcustomer/process-articles-file/1372039469");
  assert.equal(upload.body.articles.length, 1);

  fakeIndiaPost({ booking: { success: true, valid_articles: [], error_articles: [{ index: 0, errors: ["Dropoff pincode must be exactly 6 digits"] }] } });
  await assert.rejects(() => bookIndiaPostArticle(order, { config }), (error) => error.code === "INDIA_POST_REJECTED" && /6 digits/.test(error.message));

  await assert.rejects(() => bookIndiaPostArticle({ ...order, pincode: "53400" }, { config }), { code: "INDIA_POST_ORDER_DATA_INVALID" });
});

test("tracking: statuses map to Tel-Aqua fulfillment stages; unknown article is null", async () => {
  assert.equal(mapIndiaPostStatus("Item Booked"), "picked_up");
  assert.equal(mapIndiaPostStatus("In Transit"), "in_transit");
  assert.equal(mapIndiaPostStatus("Item dispatched"), "in_transit");
  assert.equal(mapIndiaPostStatus("Out for Delivery"), "out_for_delivery");
  assert.equal(mapIndiaPostStatus("Item Delivered"), "delivered");
  assert.equal(mapIndiaPostStatus("Item not delivered - Addressee absent"), "ndr");
  assert.equal(mapIndiaPostStatus("Item returned to sender"), "returned");
  fakeIndiaPost({ tracking: null });
  assert.equal(await getIndiaPostTracking("EB000000000IN", { config }), null);
});

test("Delhivery code never touches India Post shipments; tracking link points to our page", () => {
  assert.match(DELHIVERY_ONLY_SQL, /'indiapost'/);
  assert.throws(() => assertDelhiveryManagedShipment({ provider: "IndiaPost" }), { code: "INDIA_POST_MANAGED_SHIPMENT" });
  assert.equal(trackingUrlFor("EB468827991IN", "IndiaPost"), "https://lightpink-reindeer-561421.hostingersite.com/t/EB468827991IN");
  assert.equal(trackingUrlFor("SW1", "Shipway"), "https://telaqua.shipway.com/tracking/forward/SW1/");
});

/** Minimal in-memory DB for bookOrderWithIndiaPost / refreshIndiaPostShipment. */
function fakeDb({ orderRow = order, shipment = null } = {}) {
  const db = { order: { ...orderRow }, shipment: shipment ? { ...shipment } : null, history: [], audit: [] };
  const run = async (raw, params = []) => {
    const sql = raw.replace(/\s+/g, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.startsWith("SELECT * FROM orders WHERE id = ?")) return { rows: [db.order] };
    if (sql.startsWith("SELECT * FROM shipments WHERE order_id = ?")) return { rows: db.shipment ? [db.shipment] : [] };
    if (sql.startsWith("INSERT INTO shipments")) { db.shipment = { id: 9, order_id: db.order.id, waybill_number: null, fulfillment_status: "unfulfilled" }; return { rows: [], insertId: 9 }; }
    if (sql.startsWith("SELECT * FROM shipments WHERE id = ?")) return { rows: [db.shipment] };
    if (sql.startsWith("UPDATE shipments SET provider = ?, courier_name = ?, processing_token = ?")) {
      Object.assign(db.shipment, { provider: params[0], courier_name: params[1], processing_token: params[2], processing_started_at: new Date() }); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE shipments SET provider = ?, courier_name = ?, waybill_number = ?")) {
      if (db.shipment.processing_token !== params[6] || db.shipment.waybill_number) return { rows: [], rowCount: 0 };
      Object.assign(db.shipment, { provider: params[0], waybill_number: params[2], fulfillment_status: "ready_to_ship", shipment_status: "Booked", processing_token: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE shipments SET processing_token = NULL, processing_started_at = NULL, shipment_status = 'Booking Failed'")) {
      Object.assign(db.shipment, { processing_token: null, shipment_status: "Booking Failed", last_error: params[0] }); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE orders SET fulfillment_status")) { db.order.fulfillment_status = params[0] === undefined ? "ready_to_ship" : (sql.includes("= ?") && params.length === 2 ? params[0] : "ready_to_ship"); return { rows: [], rowCount: 1 }; }
    if (sql.startsWith("INSERT INTO shipment_audit_log")) { db.audit.push(params[2]); return { rows: [], rowCount: 1 }; }
    if (sql.startsWith("INSERT IGNORE INTO shipment_tracking_history")) { db.history.push(params); return { rows: [], rowCount: 1 }; }
    if (sql.startsWith("UPDATE shipments SET fulfillment_status = ?, shipment_status = COALESCE")) {
      Object.assign(db.shipment, { fulfillment_status: params[0], shipment_status: params[1] || db.shipment.shipment_status }); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE shipments SET last_tracking_update = NOW()")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  db.query = run;
  db.connect = async () => ({ query: run, release() {} });
  return db;
}

test("book order: saves article, marks Ready to Ship, sends the WhatsApp once; existing AWB blocks it", async () => {
  const db = fakeDb();
  const notified = [];
  const result = await bookOrderWithIndiaPost(1280, {
    db, notify: (id) => notified.push(id),
    book: async () => ({ barcode: "EB468827991IN", tariff: 41, raw: {} }),
  });
  assert.equal(result.barcode, "EB468827991IN");
  assert.equal(db.shipment.provider, "IndiaPost");
  assert.equal(db.shipment.waybill_number, "EB468827991IN");
  assert.equal(db.shipment.fulfillment_status, "ready_to_ship");
  assert.deepEqual(notified, [9]);
  assert.deepEqual(db.audit, ["indiapost_booked"]);

  await assert.rejects(() => bookOrderWithIndiaPost(1280, { db, book: async () => { throw new Error("must not book"); } }), /already has a shipment/);
});

test("manual record needs a valid article number and never calls India Post", async () => {
  const db = fakeDb();
  await assert.rejects(() => bookOrderWithIndiaPost(1280, { db, manual: true, barcode: "12345" }), /article number/);
  const result = await bookOrderWithIndiaPost(1280, {
    db, manual: true, barcode: "eb 468827991 in", notify: () => {},
    book: async () => { throw new Error("must not call API"); },
  });
  assert.equal(result.barcode, "EB468827991IN");
  assert.deepEqual(db.audit, ["indiapost_manual_recorded"]);
});

test("failed booking is recorded and leaves the order free to ship again", async () => {
  const db = fakeDb();
  await assert.rejects(() => bookOrderWithIndiaPost(1280, {
    db, notify: () => {},
    book: async () => { throw Object.assign(new Error("India Post rejected the booking: bad pincode"), { code: "INDIA_POST_REJECTED" }); },
  }), { code: "INDIA_POST_REJECTED" });
  assert.equal(db.shipment.waybill_number, null);
  assert.equal(db.shipment.processing_token, null);
  assert.equal(db.shipment.shipment_status, "Booking Failed");
});

test("unpaid prepaid order cannot be shipped", async () => {
  const db = fakeDb({ orderRow: { ...order, payment_mode: "razorpay", payment_status: "Pending" } });
  await assert.rejects(() => bookOrderWithIndiaPost(1280, { db, book: async () => ({ barcode: "EB468827991IN" }) }), /can be shipped/);
});

test("tracking refresh stores events and moves the order forward", async () => {
  const db = fakeDb({ shipment: { id: 9, order_id: 1280, provider: "IndiaPost", waybill_number: "EB468827991IN", fulfillment_status: "ready_to_ship" } });
  const result = await refreshIndiaPostShipment(db.shipment, {
    db,
    fetchTracking: async () => ({
      currentStatus: "In Transit", fulfillmentStatus: "in_transit", location: "Hyderabad GPO", estimatedDelivery: null, raw: {},
      history: [{ status: "Item Booked", location: "Hyderabad GPO", eventTime: "2026-11-02T10:00:00Z", raw: {} },
        { status: "In Transit", location: "Hyderabad NSH", eventTime: "2026-11-02T18:00:00Z", raw: {} }],
    }),
  });
  assert.equal(result.fulfillment_status, "in_transit");
  assert.equal(db.history.length, 2);
  assert.equal(db.shipment.fulfillment_status, "in_transit");
});
