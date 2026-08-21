import test from "node:test";
import assert from "node:assert/strict";
import { canAdvanceFulfillment, extractTrackingEvents, mapDelhiveryStatus } from "../services/logisticsState.js";
import { getDelhiveryEnvironment, getDelhiveryUrl } from "../config/delhiveryConfig.js";

test("Delhivery environment defaults to staging and never silently selects production", () => {
  const before = process.env.DELHIVERY_ENV;
  delete process.env.DELHIVERY_ENV;
  assert.equal(getDelhiveryEnvironment(), "staging");
  process.env.DELHIVERY_ENV = "invalid";
  assert.throws(() => getDelhiveryEnvironment(), /staging.*production/);
  if (before === undefined) delete process.env.DELHIVERY_ENV;
  else process.env.DELHIVERY_ENV = before;
});

test("URL selection uses exactly one configured environment", () => {
  const saved = {
    env: process.env.DELHIVERY_ENV,
    staging: process.env.DELHIVERY_STAGING_TRACKING_URL,
    production: process.env.DELHIVERY_PRODUCTION_TRACKING_URL,
  };
  process.env.DELHIVERY_STAGING_TRACKING_URL = "https://staging.example.test/track";
  process.env.DELHIVERY_PRODUCTION_TRACKING_URL = "https://production.example.test/track";
  process.env.DELHIVERY_ENV = "staging";
  assert.match(getDelhiveryUrl("tracking").url, /staging\.example/);
  process.env.DELHIVERY_ENV = "production";
  assert.match(getDelhiveryUrl("tracking").url, /production\.example/);
  for (const [key, value] of Object.entries({ DELHIVERY_ENV: saved.env, DELHIVERY_STAGING_TRACKING_URL: saved.staging, DELHIVERY_PRODUCTION_TRACKING_URL: saved.production })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("tracking states map to internal fulfillment states without terminal regression", () => {
  assert.equal(mapDelhiveryStatus("In Transit"), "in_transit");
  assert.equal(mapDelhiveryStatus("Dispatched for Delivery"), "out_for_delivery");
  assert.equal(mapDelhiveryStatus("Delivered"), "delivered");
  assert.equal(mapDelhiveryStatus("RTO Delivered"), "returned");
  assert.equal(mapDelhiveryStatus("Consignee unavailable"), "ndr");
  assert.equal(canAdvanceFulfillment("in_transit", "picked_up"), false);
  assert.equal(canAdvanceFulfillment("delivered", "in_transit"), false);
});

test("Delhivery scan history is retained as normalized events", () => {
  const events = extractTrackingEvents({ ShipmentData: [{ Shipment: { Scans: [{ ScanDetail: { Scan: "In Transit", StatusCode: "X-UCI", ScannedLocation: "Hyderabad", ScanDateTime: "2026-08-20 10:00:00" } }] } }] });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    status: "In Transit", statusCode: "X-UCI", location: "Hyderabad",
    eventTime: "2026-08-20 10:00:00", instructions: null,
    raw: { Scan: "In Transit", StatusCode: "X-UCI", ScannedLocation: "Hyderabad", ScanDateTime: "2026-08-20 10:00:00" },
  });
});
