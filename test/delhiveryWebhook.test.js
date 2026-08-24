import assert from "node:assert/strict";
import test from "node:test";

import {
  isStatusEventCurrent,
  parseDelhiveryScanPush,
  persistDelhiveryScanPush,
} from "../services/delhiveryWebhookService.js";
import { deriveShipmentStatusDisplay } from "../services/shipmentStatusDisplay.js";
import { createDelhiveryWebhookHandler } from "../controllers/delhiveryWebhookController.js";

function payload(overrides = {}) {
  const { Status: statusOverrides = {}, ...shipmentOverrides } = overrides;
  return {
    Shipment: {
      Status: {
        Status: "In Transit",
        StatusDateTime: "2026-08-24T12:30:00.000",
        StatusType: "UD",
        StatusLocation: "Hyderabad Hub",
        Instructions: "Bag connected",
        ...statusOverrides,
      },
      PickUpDate: "2026-08-24 09:00:00.000",
      NSLCode: "X-UCI",
      Sortcode: "HYD/VJA",
      ReferenceNo: "TAQ-000362",
      AWB: "61112610000943",
      ...shipmentOverrides,
    },
  };
}

function fakePool(shipmentOverrides = {}) {
  const state = {
    shipment: {
      id: 7,
      order_id: 362,
      waybill_number: "61112610000943",
      fulfillment_status: "shipment_created",
      shipment_status: "Manifested",
      shipment_status_at: "2026-08-24 10:00:00",
      ...shipmentOverrides,
    },
    eventKeys: new Set(),
    shipmentUpdates: 0,
    orderUpdates: 0,
    selectedAwb: null,
  };

  const client = {
    async query(sql, params = []) {
      if (/^SELECT \* FROM shipments/.test(sql)) {
        state.selectedAwb = params[0];
        return { rows: state.shipment ? [state.shipment] : [], rowCount: state.shipment ? 1 : 0 };
      }
      if (/^\s*INSERT IGNORE INTO shipment_tracking_history/.test(sql)) {
        const key = params[1];
        if (state.eventKeys.has(key)) return { rows: [], rowCount: 0 };
        state.eventKeys.add(key);
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*UPDATE shipments SET/.test(sql)) {
        state.shipmentUpdates += 1;
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE orders SET/.test(sql)) {
        state.orderUpdates += 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };

  return {
    state,
    pool: { async connect() { return client; } },
  };
}

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("parses Delhivery's official default Scan Push payload", () => {
  const event = parseDelhiveryScanPush(payload());
  assert.equal(event.awb, "61112610000943");
  assert.equal(event.status, "In Transit");
  assert.equal(event.statusType, "UD");
  assert.equal(event.statusDateTime, "2026-08-24 12:30:00");
  assert.equal(event.fulfillmentStatus, "in_transit");
  assert.equal(event.eventKey.length, 64);
});

test("rejects malformed or incomplete webhook payloads", () => {
  assert.throws(() => parseDelhiveryScanPush({}), /Shipment\.Status/);
  assert.throws(
    () => parseDelhiveryScanPush(payload({ AWB: "bad" })),
    /AWB is invalid/
  );
  assert.throws(
    () => parseDelhiveryScanPush(payload({ Status: { StatusDateTime: "bad" } })),
    /StatusDateTime is invalid/
  );
});

test("maps official forward and return webhook statuses", () => {
  assert.equal(
    parseDelhiveryScanPush(payload({ Status: { Status: "Dispatched", StatusType: "UD" } })).fulfillmentStatus,
    "out_for_delivery"
  );
  assert.equal(
    parseDelhiveryScanPush(payload({ Status: { Status: "Delivered", StatusType: "DL" } })).fulfillmentStatus,
    "delivered"
  );
  assert.equal(
    parseDelhiveryScanPush(payload({ Status: { Status: "In Transit", StatusType: "RT" } })).fulfillmentStatus,
    "rto"
  );
  assert.equal(
    parseDelhiveryScanPush(payload({ Status: { Status: "RTO", StatusType: "DL" } })).fulfillmentStatus,
    "returned"
  );
});

test("matches the shipment by AWB and applies a current event once", async () => {
  const fake = fakePool();
  const event = parseDelhiveryScanPush(payload());
  const first = await persistDelhiveryScanPush(event, fake.pool);
  const duplicate = await persistDelhiveryScanPush(event, fake.pool);

  assert.equal(fake.state.selectedAwb, event.awb);
  assert.equal(first.applied, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(fake.state.eventKeys.size, 1);
  assert.equal(fake.state.shipmentUpdates, 1);
  assert.equal(fake.state.orderUpdates, 1);
});

test("stores but does not apply an older event", async () => {
  const fake = fakePool({ shipment_status_at: "2026-08-24 14:00:00" });
  const result = await persistDelhiveryScanPush(
    parseDelhiveryScanPush(payload()),
    fake.pool
  );
  assert.equal(result.stale, true);
  assert.equal(result.applied, false);
  assert.equal(fake.state.eventKeys.size, 1);
  assert.equal(fake.state.shipmentUpdates, 0);
  assert.equal(fake.state.orderUpdates, 0);
});

test("does not regress a terminal shipment with a later lower-rank scan", async () => {
  const fake = fakePool({
    fulfillment_status: "delivered",
    shipment_status: "Delivered",
    shipment_status_at: "2026-08-24 11:00:00",
  });
  const result = await persistDelhiveryScanPush(
    parseDelhiveryScanPush(payload()),
    fake.pool
  );
  assert.equal(result.regressionBlocked, true);
  assert.equal(result.applied, false);
  assert.equal(fake.state.shipmentUpdates, 0);
});

test("status time comparison accepts equal/newer and rejects older events", () => {
  assert.equal(isStatusEventCurrent("2026-08-24 12:00:00", "2026-08-24 12:00:00"), true);
  assert.equal(isStatusEventCurrent("2026-08-24 12:00:00", "2026-08-24 12:00:01"), true);
  assert.equal(isStatusEventCurrent("2026-08-24 12:00:00", "2026-08-24 11:59:59"), false);
});

test("derives persisted admin labels without frontend-only state", () => {
  assert.equal(deriveShipmentStatusDisplay({ payment_status: "Paid" }), "Pending AWB");
  assert.equal(
    deriveShipmentStatusDisplay({ payment_status: "Paid", waybill: "61112610000943" }),
    "Ready to Pickup"
  );
  assert.equal(
    deriveShipmentStatusDisplay({ tracking_status: "Picked Up", shipment_status_code: "UD" }),
    "Picked Up"
  );
  assert.equal(
    deriveShipmentStatusDisplay({ tracking_status: "Undelivered", shipment_status_code: "UD" }),
    "Undelivered"
  );
  assert.equal(
    deriveShipmentStatusDisplay({ tracking_status: "In Transit", shipment_status_code: "RT" }),
    "RTO In-Transit"
  );
});

test("webhook handler validates the configured header and returns Delhivery's expected 200", async () => {
  const savedHeader = process.env.DELHIVERY_WEBHOOK_AUTH_HEADER;
  const savedValue = process.env.DELHIVERY_WEBHOOK_AUTH_VALUE;
  const savedIps = process.env.DELHIVERY_WEBHOOK_ALLOWED_IPS;
  process.env.DELHIVERY_WEBHOOK_AUTH_HEADER = "X-Tel-Aqua-Webhook-Token";
  process.env.DELHIVERY_WEBHOOK_AUTH_VALUE = "test-secret";
  delete process.env.DELHIVERY_WEBHOOK_ALLOWED_IPS;

  try {
    const fake = fakePool();
    const handler = createDelhiveryWebhookHandler(fake.pool);
    const request = {
      body: Buffer.from(JSON.stringify(payload())),
      ip: "13.229.195.68",
      get(name) {
        return name.toLowerCase() === "x-tel-aqua-webhook-token"
          ? "test-secret"
          : undefined;
      },
    };
    const response = mockResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.applied, true);

    const unauthorized = mockResponse();
    await handler({ ...request, get() { return "wrong"; } }, unauthorized);
    assert.equal(unauthorized.statusCode, 401);
  } finally {
    if (savedHeader === undefined) delete process.env.DELHIVERY_WEBHOOK_AUTH_HEADER;
    else process.env.DELHIVERY_WEBHOOK_AUTH_HEADER = savedHeader;
    if (savedValue === undefined) delete process.env.DELHIVERY_WEBHOOK_AUTH_VALUE;
    else process.env.DELHIVERY_WEBHOOK_AUTH_VALUE = savedValue;
    if (savedIps === undefined) delete process.env.DELHIVERY_WEBHOOK_ALLOWED_IPS;
    else process.env.DELHIVERY_WEBHOOK_ALLOWED_IPS = savedIps;
  }
});
