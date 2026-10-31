import assert from "node:assert/strict";
import test from "node:test";

import {
  buildShippedBodyValues,
  getShippedTemplateConfig,
  resetShipmentTrackingNotificationStateForTests,
  sendShipmentTrackingWhatsApp,
  shipwayTrackingUrl,
  trackingUrlFor,
} from "../services/shipmentTrackingNotificationService.js";
import { runShipwayPendingAwbSync } from "../services/shipwayTrackingSyncService.js";

const ENABLED = { INTERAKT_SHIPPED_ENABLED: "true" };

/** In-memory shipments + orders + shipment_tracking_notifications. */
function fakeDb({ shipment = {}, order = {} } = {}) {
  const db = {
    shipment: { id: 7, order_id: 1235, waybill_number: "SMMC1003902898", provider: "Shipway", courier_name: "Ekart Brand Surface", ...shipment },
    order: { id: 1235, customer_name: "Asha Rao", phone: "9876543210", order_number: "TAQ-001235", is_test_order: 0, ...order },
    notifications: new Map(),
    calls: [],
  };
  db.query = async (raw, params = []) => {
    const sql = raw.replace(/\s+/g, " ").trim();
    db.calls.push(sql);
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS shipment_tracking_notifications")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT s.id AS shipment_id")) {
      if (params[0] !== db.shipment.id) return { rows: [], rowCount: 0 };
      const s = db.shipment; const o = db.order;
      return { rows: [{ shipment_id: s.id, order_id: s.order_id, waybill_number: s.waybill_number, provider: s.provider, courier_name: s.courier_name,
        customer_name: o.customer_name, phone: o.phone, order_number: o.order_number, is_test_order: o.is_test_order }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO shipment_tracking_notifications")) {
      const [shipmentId, , awb] = params;
      if (db.notifications.has(shipmentId)) throw Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
      db.notifications.set(shipmentId, { status: "sending", awb, attempts: 1 });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE shipment_tracking_notifications SET status = 'sending'")) {
      const [awb, shipmentId] = params;
      const allowed = sql.match(/status IN \(([^)]*)\)/)[1].split(",").map((v) => v.trim().replace(/'/g, ""));
      const row = db.notifications.get(shipmentId);
      if (!row || !allowed.includes(row.status)) return { rows: [], rowCount: 0 };
      Object.assign(row, { status: "sending", awb, attempts: row.attempts + 1 });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE shipment_tracking_notifications SET status = ?")) {
      const [status, error, , shipmentId] = params;
      Object.assign(db.notifications.get(shipmentId), { status, last_error: error });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return db;
}

function recorder({ fail = false } = {}) {
  const sent = [];
  const send = async (payload) => {
    sent.push(payload);
    if (fail) throw new Error("Template not approved");
    return { ok: true };
  };
  return { sent, send };
}

test.beforeEach(() => resetShipmentTrackingNotificationStateForTests());

test("tracking link: Shipway page for the AWB, configurable base, Delhivery only for non-Shipway", () => {
  assert.equal(shipwayTrackingUrl("SMMC1003902898"), "https://telaqua.shipway.com/tracking/forward/SMMC1003902898/");
  assert.equal(shipwayTrackingUrl(" SMMC1 ", "https://track.example.com/t"), "https://track.example.com/t/SMMC1/");
  assert.equal(shipwayTrackingUrl("A B/C"), "https://telaqua.shipway.com/tracking/forward/A%20B%2FC/");
  assert.equal(shipwayTrackingUrl("SMMC1", "not a url"), "https://telaqua.shipway.com/tracking/forward/SMMC1/");
  assert.equal(shipwayTrackingUrl(""), null);
  assert.equal(trackingUrlFor("SMMC1", "Shipway"), "https://telaqua.shipway.com/tracking/forward/SMMC1/");
  assert.equal(trackingUrlFor("123", "Delhivery"), "https://www.delhivery.com/track/package/123");
  assert.equal(trackingUrlFor("123", null), "https://www.delhivery.com/track/package/123");
  assert.equal(trackingUrlFor("", "Shipway"), null);
});

test("disabled by default: nothing is read or sent until INTERAKT_SHIPPED_ENABLED=true", async () => {
  assert.equal(getShippedTemplateConfig({}).enabled, false);
  const db = fakeDb();
  const { sent, send } = recorder();
  const result = await sendShipmentTrackingWhatsApp(7, { db, env: {}, send });
  assert.deepEqual(result, { sent: false, skipped: "disabled" });
  assert.equal(sent.length, 0);
  assert.equal(db.calls.length, 0);
});

test("sends once with name/order/courier and the AWB as the Track button value", async () => {
  const db = fakeDb();
  const { sent, send } = recorder();
  const first = await sendShipmentTrackingWhatsApp(7, { db, env: ENABLED, send });
  assert.equal(first.sent, true);
  assert.equal(first.trackingUrl, "https://telaqua.shipway.com/tracking/forward/SMMC1003902898/");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].countryCode, "+91");
  assert.equal(sent[0].phoneNumber, "9876543210");
  assert.equal(sent[0].template.name, "order_shipped_tracking");
  assert.deepEqual(sent[0].template.bodyValues, ["Asha Rao", "TAQ-001235", "Ekart Brand Surface"]);
  assert.deepEqual(sent[0].template.buttonValues, { 0: ["SMMC1003902898"] });
  assert.equal(db.notifications.get(7).status, "sent");

  // Booking, reconcile and the background sync may all fire: only one message goes out.
  const second = await sendShipmentTrackingWhatsApp(7, { db, env: ENABLED, send });
  assert.deepEqual(second, { sent: false, skipped: "already_sent", trackingUrl: first.trackingUrl });
  assert.equal(sent.length, 1);
});

test("url button mode sends the full link; body fields are configurable", async () => {
  const db = fakeDb();
  const { sent, send } = recorder();
  await sendShipmentTrackingWhatsApp(7, {
    db, send,
    env: { ...ENABLED, INTERAKT_SHIPPED_BUTTON_MODE: "url", INTERAKT_SHIPPED_BODY_FIELDS: "name,order_number,awb,tracking_url", INTERAKT_SHIPPED_TEMPLATE_NAME: "shipped_v2" },
  });
  assert.equal(sent[0].template.name, "shipped_v2");
  assert.deepEqual(sent[0].template.buttonValues, { 0: ["https://telaqua.shipway.com/tracking/forward/SMMC1003902898/"] });
  assert.deepEqual(sent[0].template.bodyValues, ["Asha Rao", "TAQ-001235", "SMMC1003902898", "https://telaqua.shipway.com/tracking/forward/SMMC1003902898/"]);
  assert.deepEqual(buildShippedBodyValues({}, ["courier", "product"]), ["our courier partner", "Tel-Aqua pH Meter"]);
});

test("a failed send is recorded and retried by the next trigger; admin can force a resend", async () => {
  const db = fakeDb();
  const failing = recorder({ fail: true });
  const failed = await sendShipmentTrackingWhatsApp(7, { db, env: ENABLED, send: failing.send });
  assert.equal(failed.sent, false);
  assert.match(failed.error, /Template not approved/);
  assert.equal(db.notifications.get(7).status, "failed");

  const ok = recorder();
  assert.equal((await sendShipmentTrackingWhatsApp(7, { db, env: ENABLED, send: ok.send })).sent, true);
  assert.equal(db.notifications.get(7).status, "sent");
  assert.equal(db.notifications.get(7).attempts, 2);

  // Admin "Send on WhatsApp" resends even after a successful send (and works while auto-send is off).
  assert.equal((await sendShipmentTrackingWhatsApp(7, { db, env: {}, send: ok.send, force: true })).sent, true);
  assert.equal(ok.sent.length, 2);
});

test("skips: no AWB, not Shipway, test order, invalid phone, unknown shipment", async () => {
  const cases = [
    [{ shipment: { waybill_number: null } }, "no_awb"],
    [{ shipment: { provider: "Delhivery" } }, "not_shipway"],
    [{ order: { is_test_order: 1 } }, "test_order"],
    [{ order: { phone: "12345" } }, "invalid_phone"],
  ];
  for (const [setup, reason] of cases) {
    resetShipmentTrackingNotificationStateForTests();
    const { sent, send } = recorder();
    const result = await sendShipmentTrackingWhatsApp(7, { db: fakeDb(setup), env: ENABLED, send });
    assert.equal(result.skipped, reason, reason);
    assert.equal(sent.length, 0, reason);
  }
  const { send } = recorder();
  assert.equal((await sendShipmentTrackingWhatsApp(999, { db: fakeDb(), env: ENABLED, send })).skipped, "shipment_not_found");
  assert.equal((await sendShipmentTrackingWhatsApp("abc", { db: fakeDb(), env: ENABLED, send })).skipped, "invalid_shipment");
});

test("pending-AWB sync notifies the customer only for the shipment whose AWB was just saved", async () => {
  const shipments = new Map([
    [1, { id: 1, order_id: 1119, provider: "Shipway", waybill_number: null, shipment_status: "Booking Failed" }],
    [2, { id: 2, order_id: 1140, provider: "Shipway", waybill_number: null, shipment_status: "Booking Failed" }],
  ]);
  const orders = new Map([[1119, { order_number: "TAQ-001119" }], [1140, { order_number: "TAQ-001140" }]]);
  const db = {
    query: async (raw, params = []) => {
      const sql = raw.replace(/\s+/g, " ").trim();
      if (sql.startsWith("SELECT s.*, o.order_number AS shipway_order_number")) {
        const rows = [...shipments.values()].filter((s) => !s.waybill_number).map((s) => ({ ...s, shipway_order_number: orders.get(s.order_id).order_number }));
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("UPDATE shipments SET provider = 'Shipway', waybill_number = ?")) {
        shipments.get(params[7]).waybill_number = params[0];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const notified = [];
  const lookup = async (orderNumber) => (orderNumber === "TAQ-001119"
    ? { state: "exists", awb: "SMMC1", labelUrl: "https://labels.example/1.pdf", carrierName: "Ekart", body: {} }
    : { state: "exists", awb: null, body: {} });
  await runShipwayPendingAwbSync({ db, lookup, env: { SHIPWAY_TRACKING_SYNC_PACE_MS: "0" }, notifyShipped: (id) => notified.push(id) });
  assert.deepEqual(notified, [1]);
});
