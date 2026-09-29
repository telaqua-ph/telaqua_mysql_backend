import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCourierUpdatePayload,
  classifyShipmentStage,
  diffDeliveryDetails,
  saveOrderDeliveryDetails,
  validateDeliveryDetails,
} from "../services/orderDeliveryDetails.js";
import { deliveryDetailsDeps } from "../controllers/orderDeliveryDetailsController.js";

const baseOrder = Object.freeze({
  id: 806,
  order_number: "TAQ-000806",
  customer_name: "Gowtham",
  phone: "9573398770",
  email: "kagithalagowthamkumar@gmail.com",
  address: "3/74, Varahapatnam Kaikalur ( md ) eluru (dt)",
  city: "Krishna",
  state: "Andhra Pradesh",
  pincode: "521333",
  order_status: "Confirmed",
  payment_status: "Pending",
  payment_mode: "cod",
  payment_method: "cod",
  total_amount: "1799.00",
  final_total: "1799.00",
  promo_code: "SN40",
  fulfillment_status: "unfulfilled",
});

const corrected = Object.freeze({
  customer_name: "Gowtham Kumar",
  phone: "+91 95733 98771",
  address: "3/74, Varahapatnam, Kaikalur Mandal, Eluru District",
  city: "Krishna",
  state: "Andhra Pradesh",
  pincode: "521333",
});

const admin = { id: 2, email: "telaquaph02@gmail.com" };

/** In-memory stand-in for the DB + Delhivery; records every side effect. */
function fakeDeps({ order = baseOrder, shipment = null, afterTracking = null, courierError = null, lastAudit = null } = {}) {
  const state = {
    order: { ...order },
    shipment: shipment ? { ...shipment } : null,
    pushes: [],
    persisted: [],
    trackingCalls: 0,
    locks: 0,
    releases: [],
  };
  const deps = {
    loadOrder: async () => ({ ...state.order }),
    loadShipment: async () => (state.shipment ? { ...state.shipment } : null),
    refreshTracking: async () => {
      state.trackingCalls += 1;
      if (afterTracking) Object.assign(state.shipment, afterTracking);
    },
    latestAudit: async () => lastAudit,
    lockShipment: async () => {
      state.locks += 1;
      return "token-1";
    },
    pushToCourier: async (payload) => {
      state.pushes.push(payload);
      if (courierError) throw courierError;
      return { status: true, waybill: payload.waybill, remark: "" };
    },
    releaseShipment: async (args) => {
      state.releases.push(args.courier.status);
    },
    persist: async (args) => {
      state.persisted.push(args);
      if (args.changes.length) Object.assign(state.order, args.data);
    },
  };
  return { deps, state };
}

const readyForPickupShipment = Object.freeze({
  id: 41,
  order_id: 805,
  environment: "production",
  waybill_number: "66637810001142",
  shipment_id: "66637810001142",
  shipment_created_at: "2026-09-29 12:40:00",
  fulfillment_status: "shipment_created",
  shipment_status: "Manifested",
});

/* ─── Validation ─────────────────────────────────────────────────────── */

test("validation: required fields are reported individually", () => {
  const result = validateDeliveryDetails({ customer_name: " ", phone: "", address: "", city: "", state: "", pincode: "" });
  assert.deepEqual(Object.keys(result.errors).sort(), ["address", "city", "customer_name", "phone", "pincode", "state"]);
  assert.match(result.errors.phone, /required/);
});

test("validation: rejects non-Indian / wrong-length mobile numbers", () => {
  for (const phone of ["95733987", "957339877012", "5573398770", "0000000000", "95733abc70"]) {
    const result = validateDeliveryDetails({ ...corrected, phone });
    assert.ok(result.errors?.phone, `expected phone error for ${phone}`);
    assert.match(result.errors.phone, /10-digit Indian mobile/);
  }
});

test("validation: accepts +91 / 0 / spaced formats and stores 10 digits", () => {
  for (const phone of ["+91 95733 98771", "09573398771", "9573398771", "919573398771"]) {
    const result = validateDeliveryDetails({ ...corrected, phone });
    assert.equal(result.errors, undefined, phone);
    assert.equal(result.data.phone, "9573398771");
  }
});

test("validation: PIN code must be exactly 6 digits", () => {
  for (const pincode of ["52133", "5213334", "052133", "52A333"]) {
    const result = validateDeliveryDetails({ ...corrected, pincode });
    assert.match(result.errors?.pincode || "", /6 digits/, pincode);
  }
  assert.equal(validateDeliveryDetails({ ...corrected, pincode: " 521 333 " }).data.pincode, "521333");
});

test("save: validation failure returns 400 and never reads or writes the order", async () => {
  const { deps, state } = fakeDeps();
  let loaded = false;
  deps.loadOrder = async () => { loaded = true; return baseOrder; };
  const result = await saveOrderDeliveryDetails(
    { orderId: 806, body: { ...corrected, phone: "12345", pincode: "1234" }, admin },
    deps
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "VALIDATION_FAILED");
  assert.ok(result.body.errors.phone && result.body.errors.pincode);
  assert.equal(loaded, false);
  assert.equal(state.persisted.length, 0);
});

/* ─── Stage classification ───────────────────────────────────────────── */

test("classification covers every fulfillment stage", () => {
  const cases = [
    [null, "not_created"],
    [{ waybill_number: "123", fulfillment_status: "ready_to_ship" }, "not_created"],
    [{ ...readyForPickupShipment }, "awaiting_pickup"],
    [{ ...readyForPickupShipment, fulfillment_status: "pickup_requested" }, "awaiting_pickup"],
    [{ ...readyForPickupShipment, fulfillment_status: "picked_up" }, "in_transit"],
    [{ ...readyForPickupShipment, fulfillment_status: "in_transit" }, "in_transit"],
    [{ ...readyForPickupShipment, fulfillment_status: "out_for_delivery" }, "in_transit"],
    [{ ...readyForPickupShipment, fulfillment_status: "ndr" }, "in_transit"],
    [{ ...readyForPickupShipment, fulfillment_status: "delivered" }, "closed"],
    [{ ...readyForPickupShipment, fulfillment_status: "cancelled" }, "closed"],
  ];
  for (const [shipment, expected] of cases) {
    assert.equal(classifyShipmentStage(baseOrder, shipment).stage, expected, JSON.stringify(shipment));
  }
  assert.equal(classifyShipmentStage({ ...baseOrder, order_status: "Cancelled" }, null).stage, "closed");
});

/* ─── Order without AWB ──────────────────────────────────────────────── */

test("no AWB: saves only delivery fields, no Delhivery call, audit records who/what", async () => {
  const { deps, state } = fakeDeps();
  const result = await saveOrderDeliveryDetails({ orderId: 806, body: corrected, admin }, deps);

  assert.equal(result.status, 200);
  assert.equal(result.body.courier_sync.status, "not_required");
  assert.match(result.body.message, /used when the Delhivery shipment is created/);
  assert.deepEqual(result.body.changes, ["customer_name", "phone", "address"]);
  assert.equal(state.pushes.length, 0);
  assert.equal(state.trackingCalls, 0);

  const [saved] = state.persisted;
  assert.equal(saved.admin, admin);
  assert.equal(saved.action, "delivery_details_updated");
  assert.deepEqual(Object.keys(saved.data).sort(), ["address", "city", "customer_name", "phone", "pincode", "state"]);
  assert.equal(saved.data.phone, "9573398771");

  // Payment / totals / status / promo untouched.
  for (const key of ["order_status", "payment_status", "payment_mode", "total_amount", "final_total", "promo_code", "email", "fulfillment_status"]) {
    assert.equal(result.body.order[key], baseOrder[key], key);
  }
});

test("no AWB: PIN / city / state can be corrected before the shipment exists", async () => {
  const { deps, state } = fakeDeps();
  const result = await saveOrderDeliveryDetails(
    { orderId: 806, body: { ...corrected, city: "Eluru", pincode: "534001" }, admin },
    deps
  );
  assert.equal(result.status, 200);
  assert.ok(result.body.changes.includes("pincode"));
  assert.equal(state.order.pincode, "534001");
  assert.equal(state.pushes.length, 0);
});

test("reserved AWB but shipment not manifested yet is still a DB-only edit", async () => {
  const { deps, state } = fakeDeps({
    shipment: { id: 9, waybill_number: "66637810009999", fulfillment_status: "ready_to_ship" },
  });
  const result = await saveOrderDeliveryDetails({ orderId: 806, body: corrected, admin }, deps);
  assert.equal(result.status, 200);
  assert.equal(result.body.shipment.stage, "not_created");
  assert.equal(state.pushes.length, 0);
});

test("no changes returns 400 NO_CHANGES", async () => {
  const { deps, state } = fakeDeps();
  const result = await saveOrderDeliveryDetails({ orderId: 806, body: { ...baseOrder }, admin }, deps);
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "NO_CHANGES");
  assert.equal(state.persisted.length, 0);
});

/* ─── Ready for Pickup (AWB created) ─────────────────────────────────── */

test("Ready for Pickup: re-checks tracking, pushes name/add/phone to Delhivery, then saves", async () => {
  const order = { ...baseOrder, id: 805, fulfillment_status: "shipment_created" };
  const { deps, state } = fakeDeps({ order, shipment: readyForPickupShipment });
  const result = await saveOrderDeliveryDetails({ orderId: 805, body: corrected, admin }, deps);

  assert.equal(result.status, 200);
  assert.equal(state.trackingCalls, 1);
  assert.equal(state.locks, 1);
  assert.deepEqual(state.pushes, [{
    waybill: "66637810001142",
    name: "Gowtham Kumar",
    add: "3/74, Varahapatnam, Kaikalur Mandal, Eluru District",
    phone: "9573398771",
  }]);
  assert.deepEqual(state.releases, ["updated"]);
  assert.equal(result.body.courier_sync.status, "updated");
  assert.match(result.body.message, /Delhivery accepted the change for AWB 66637810001142/);
  assert.equal(state.persisted[0].courier.status, "updated");
});

test("Ready for Pickup: Delhivery failure is saved locally but never reported as updated", async () => {
  const order = { ...baseOrder, id: 805, fulfillment_status: "shipment_created" };
  const courierError = Object.assign(new Error("Edit not allowed for this waybill"), {
    code: "DELHIVERY_UPSTREAM_ERROR",
    upstreamBody: { status: false, error: "Edit not allowed for this waybill" },
  });
  const { deps, state } = fakeDeps({ order, shipment: readyForPickupShipment, courierError });
  const result = await saveOrderDeliveryDetails({ orderId: 805, body: corrected, admin }, deps);

  assert.equal(result.status, 200);
  assert.equal(result.body.courier_sync.status, "failed");
  assert.match(result.body.message, /Delhivery was NOT updated/);
  assert.match(result.body.message, /still has the old details/);
  assert.doesNotMatch(result.body.message, /accepted/);
  assert.deepEqual(state.releases, ["failed"]);
  assert.equal(state.persisted[0].courier.status, "failed");
});

test("Ready for Pickup: failed sync can be retried without changing fields", async () => {
  const order = { ...baseOrder, id: 805, ...validateDeliveryDetails(corrected).data, fulfillment_status: "shipment_created" };
  const { deps, state } = fakeDeps({ order, shipment: readyForPickupShipment, lastAudit: { courier_status: "failed" } });
  const result = await saveOrderDeliveryDetails({ orderId: 805, body: corrected, admin }, deps);
  assert.equal(result.status, 200);
  assert.equal(state.pushes.length, 1);
  assert.equal(state.persisted[0].action, "courier_sync_retry");
  assert.equal(result.body.courier_sync.status, "updated");
});

test("Ready for Pickup: PIN/city/state change is blocked (Delhivery edit API cannot change it)", async () => {
  const order = { ...baseOrder, id: 805, fulfillment_status: "shipment_created" };
  const { deps, state } = fakeDeps({ order, shipment: readyForPickupShipment });
  const result = await saveOrderDeliveryDetails(
    { orderId: 805, body: { ...corrected, pincode: "534001", city: "Eluru" }, admin },
    deps
  );
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "COURIER_FIELD_UNSUPPORTED");
  assert.deepEqual(result.body.fields.sort(), ["city", "pincode"]);
  assert.match(result.body.message, /order was not changed/);
  assert.equal(state.pushes.length, 0);
  assert.equal(state.persisted.length, 0);
});

test("Ready for Pickup in DB but live tracking shows picked up → blocked", async () => {
  const order = { ...baseOrder, id: 805, fulfillment_status: "shipment_created" };
  const { deps, state } = fakeDeps({
    order,
    shipment: readyForPickupShipment,
    afterTracking: { fulfillment_status: "picked_up" },
  });
  const result = await saveOrderDeliveryDetails({ orderId: 805, body: corrected, admin }, deps);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "COURIER_LOCKED");
  assert.equal(result.body.shipment.tracking_checked, true);
  assert.equal(state.pushes.length, 0);
  assert.equal(state.persisted.length, 0);
});

test("Ready for Pickup: tracking check failure falls back to stored status", async () => {
  const order = { ...baseOrder, id: 805, fulfillment_status: "shipment_created" };
  const { deps, state } = fakeDeps({ order, shipment: readyForPickupShipment });
  deps.refreshTracking = async () => { throw Object.assign(new Error("throttled"), { code: "DELHIVERY_THROTTLED" }); };
  const result = await saveOrderDeliveryDetails({ orderId: 805, body: corrected, admin }, deps);
  assert.equal(result.status, 200);
  assert.equal(result.body.shipment.tracking_checked, false);
  assert.equal(state.pushes.length, 1);
});

test("Ready for Pickup: another shipment operation in progress → 409, nothing saved", async () => {
  const order = { ...baseOrder, id: 805, fulfillment_status: "shipment_created" };
  const { deps, state } = fakeDeps({ order, shipment: readyForPickupShipment });
  deps.lockShipment = async () => {
    throw Object.assign(new Error("busy"), { httpStatus: 409, publicMessage: "Another shipment operation is already in progress." });
  };
  const result = await saveOrderDeliveryDetails({ orderId: 805, body: corrected, admin }, deps);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "SHIPMENT_BUSY");
  assert.equal(state.pushes.length, 0);
  assert.equal(state.persisted.length, 0);
});

/* ─── In Transit and later ───────────────────────────────────────────── */

test("In Transit: blocked with Delhivery guidance, order not modified", async () => {
  const order = { ...baseOrder, id: 790, fulfillment_status: "in_transit" };
  const shipment = { ...readyForPickupShipment, order_id: 790, fulfillment_status: "in_transit", shipment_status: "In Transit" };
  const { deps, state } = fakeDeps({ order, shipment });
  const result = await saveOrderDeliveryDetails({ orderId: 790, body: corrected, admin }, deps);

  assert.equal(result.status, 409);
  assert.equal(result.body.code, "COURIER_LOCKED");
  assert.match(result.body.message, /already In Transit \(AWB 66637810001142\)/);
  assert.match(result.body.message, /Contact Delhivery support/);
  assert.equal(state.trackingCalls, 0);
  assert.equal(state.pushes.length, 0);
  assert.equal(state.persisted.length, 0);
  assert.equal(state.order.phone, baseOrder.phone);
});

test("NDR: blocked but points to the NDR EDIT_DETAILS action", async () => {
  const shipment = { ...readyForPickupShipment, fulfillment_status: "ndr" };
  const { deps } = fakeDeps({ shipment });
  const result = await saveOrderDeliveryDetails({ orderId: 806, body: corrected, admin }, deps);
  assert.equal(result.status, 409);
  assert.match(result.body.message, /EDIT_DETAILS/);
});

test("Delivered / cancelled orders are closed", async () => {
  for (const [order, shipment] of [
    [baseOrder, { ...readyForPickupShipment, fulfillment_status: "delivered" }],
    [{ ...baseOrder, order_status: "Cancelled" }, null],
  ]) {
    const { deps, state } = fakeDeps({ order, shipment });
    const result = await saveOrderDeliveryDetails({ orderId: 806, body: corrected, admin }, deps);
    assert.equal(result.status, 409);
    assert.equal(state.persisted.length, 0);
  }
});

/* ─── Helpers ────────────────────────────────────────────────────────── */

test("diff ignores whitespace-only differences", () => {
  const changes = diffDeliveryDetails(baseOrder, { ...baseOrder, address: `  ${baseOrder.address}  ` });
  assert.deepEqual(changes, []);
});

test("courier payload strips characters Delhivery rejects", () => {
  const payload = buildCourierUpdatePayload("123", { customer_name: "A & B", address: "Flat #4; Road\\1", phone: "9876543210" });
  assert.deepEqual(payload, { waybill: "123", name: "A B", add: "Flat 4 Road 1", phone: "9876543210" });
});

/* ─── Real Delhivery edit call (fetch stubbed) ───────────────────────── */

const originalFetch = globalThis.fetch;
function withEditEndpoint(callback) {
  const saved = {
    DELHIVERY_API_TOKEN: process.env.DELHIVERY_API_TOKEN,
    DELHIVERY_ENV: process.env.DELHIVERY_ENV,
    DELHIVERY_STAGING_SHIPMENT_UPDATE_URL: process.env.DELHIVERY_STAGING_SHIPMENT_UPDATE_URL,
  };
  process.env.DELHIVERY_API_TOKEN = "test-token";
  process.env.DELHIVERY_ENV = "staging";
  process.env.DELHIVERY_STAGING_SHIPMENT_UPDATE_URL = "https://staging-express.delhivery.com/api/p/edit";
  return Promise.resolve().then(callback).finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("pushToCourier POSTs the edit payload to Delhivery /api/p/edit", async () => {
  await withEditEndpoint(async () => {
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({ status: true, waybill: "66637810001142", remark: "" }), { status: 200 });
    };
    const payload = { waybill: "66637810001142", name: "Gowtham Kumar", add: "3/74 Varahapatnam", phone: "9573398771" };
    await deliveryDetailsDeps.pushToCourier(payload);
    assert.equal(request.url, "https://staging-express.delhivery.com/api/p/edit");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers.Authorization, "Token test-token");
    assert.deepEqual(JSON.parse(request.options.body), payload);
  });
});

test("pushToCourier treats an HTTP 200 rejection body as a failure", async () => {
  await withEditEndpoint(async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: false, error: "Shipment edit not allowed in current status" }), { status: 200 });
    await assert.rejects(
      deliveryDetailsDeps.pushToCourier({ waybill: "1", phone: "9573398771" }),
      /edit not allowed/i
    );
  });
});

test("pushToCourier surfaces HTTP errors", async () => {
  await withEditEndpoint(async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ detail: "Unauthorized" }), { status: 401 });
    await assert.rejects(deliveryDetailsDeps.pushToCourier({ waybill: "1", phone: "9573398771" }), /Unauthorized/);
  });
});

/* ─── persist(): SQL issued inside the transaction (fake connection) ─── */

import { pool } from "../config/db.js";

function fakeConnection({ order, shipment }) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ text, params });
      if (/^SELECT \* FROM orders/.test(text)) return { rows: order ? [order] : [], rowCount: order ? 1 : 0 };
      if (/^SELECT \* FROM shipments/.test(text)) return { rows: shipment ? [shipment] : [], rowCount: shipment ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { client, calls };
}

async function withFakePool(fake, callback) {
  const saved = { connect: pool.connect, query: pool.query };
  pool.connect = async () => fake.client;
  pool.query = async () => ({ rows: [], rowCount: 0 });
  try {
    return await callback();
  } finally {
    pool.connect = saved.connect;
    pool.query = saved.query;
  }
}

test("persist: updates only the six delivery columns of this order and writes the audit row", async () => {
  const fake = fakeConnection({ order: { ...baseOrder }, shipment: null });
  const data = validateDeliveryDetails(corrected).data;
  await withFakePool(fake, () =>
    deliveryDetailsDeps.persist({
      order: baseOrder,
      shipment: null,
      data,
      changes: diffDeliveryDetails(baseOrder, data),
      classification: classifyShipmentStage(baseOrder, null),
      courier: { status: "not_required", message: "n/a" },
      admin,
      action: "delivery_details_updated",
    })
  );

  const texts = fake.calls.map((call) => call.text);
  assert.equal(texts[0], "BEGIN");
  assert.equal(texts.at(-1), "COMMIT");
  assert.ok(texts.some((t) => /^SELECT \* FROM orders WHERE id = \? LIMIT 1 FOR UPDATE$/.test(t)));

  const update = fake.calls.find((call) => call.text.startsWith("UPDATE orders"));
  assert.equal(
    update.text,
    "UPDATE orders SET customer_name = ?, phone = ?, address = ?, city = ?, state = ?, pincode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  );
  assert.deepEqual(update.params, [data.customer_name, "9573398771", data.address, data.city, data.state, data.pincode, 806]);
  assert.ok(!/payment|total|order_status|waybill|fulfillment|promo/.test(update.text));

  const audit = fake.calls.find((call) => call.text.startsWith("INSERT INTO order_delivery_audit_log"));
  assert.equal(audit.params[0], 806);           // order_id
  assert.equal(audit.params[2], 2);             // admin_id
  assert.equal(audit.params[3], "telaquaph02@gmail.com");
  assert.equal(audit.params[4], "delivery_details_updated");
  assert.deepEqual(JSON.parse(audit.params[7]), ["customer_name", "phone", "address"]);
  assert.equal(JSON.parse(audit.params[8]).phone, "9573398770");   // before
  assert.equal(JSON.parse(audit.params[9]).phone, "9573398771");   // after
  assert.equal(audit.params[10], "not_required");
  assert.ok(!texts.some((t) => t.startsWith("INSERT INTO shipment_audit_log")));
});

test("persist: rolls back if a shipment was created concurrently after a DB-only decision", async () => {
  const fake = fakeConnection({ order: { ...baseOrder }, shipment: { ...readyForPickupShipment } });
  const data = validateDeliveryDetails(corrected).data;
  await withFakePool(fake, () =>
    assert.rejects(
      deliveryDetailsDeps.persist({
        order: baseOrder,
        shipment: null,
        data,
        changes: diffDeliveryDetails(baseOrder, data),
        classification: classifyShipmentStage(baseOrder, null),
        courier: { status: "not_required" },
        admin,
        action: "delivery_details_updated",
      }),
      (error) => error.httpStatus === 409
    )
  );
  const texts = fake.calls.map((call) => call.text);
  assert.ok(texts.includes("ROLLBACK"));
  assert.ok(!texts.some((t) => t.startsWith("UPDATE orders")));
});

test("persist: courier-synced edit also lands in the shipment audit log", async () => {
  const fake = fakeConnection({ order: { ...baseOrder }, shipment: { ...readyForPickupShipment } });
  const data = validateDeliveryDetails(corrected).data;
  await withFakePool(fake, () =>
    deliveryDetailsDeps.persist({
      order: baseOrder,
      shipment: readyForPickupShipment,
      data,
      changes: diffDeliveryDetails(baseOrder, data),
      classification: classifyShipmentStage(baseOrder, readyForPickupShipment),
      courier: { status: "updated", message: "ok", payload: { waybill: "66637810001142" }, response: { status: true } },
      admin,
      action: "delivery_details_updated",
    })
  );
  const shipmentAudit = fake.calls.find((call) => call.text.startsWith("INSERT INTO shipment_audit_log"));
  assert.equal(shipmentAudit.params[0], 41);
  assert.equal(shipmentAudit.params[2], "delivery_details_updated");
});
