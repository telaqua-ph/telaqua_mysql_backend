import assert from "node:assert/strict";
import test from "node:test";
import { buildMapScope, getMapBasemap, parseMapFilters } from "../controllers/farmerIntelController.js";
import { normalizeCourierAssignment } from "../services/courierAssignment.js";

test("Farmer Intel map scope uses one orders row with shipment EXISTS predicates", () => {
  const filters = parseMapFilters({ from: "2026-11-01", to: "2026-11-20", status: "returned" });
  const scope = buildMapScope(filters);
  assert.match(scope.where, /FROM shipments sr WHERE sr\.order_id = o\.id/);
  assert.match(scope.where, /DATE_ADD\(o\.created_at, INTERVAL 330 MINUTE\)/);
  assert.equal(scope.params.join(","), "2026-11-01,2026-11-20");
  assert.doesNotMatch(scope.where, /WITH\s/i);
});

test("Farmer Intel filter parser rejects invalid ranges", () => {
  assert.throws(() => parseMapFilters({ from: "2026-11-31" }), /valid/);
  assert.throws(() => parseMapFilters({ from: "2026-11-21", to: "2026-11-20" }), /valid/);
});

test("Farmer Intel basemap endpoint returns state geometry without order records", () => {
  let responseBody;
  const response = { json(body) { responseBody = body; return body; } };
  getMapBasemap({}, response);

  assert.equal(responseBody.success, true);
  assert.equal(responseBody.basemap.statePaths.length, 36);
  assert.ok(responseBody.basemap.indiaPath.startsWith("M"));
  assert.ok(responseBody.basemap.source.includes("CC BY 4.0"));
  assert.deepEqual(Object.keys(responseBody.basemap.statePaths[0]).sort(), ["name", "path"]);
  assert.equal("orders" in responseBody.basemap, false);
  assert.equal("pins" in responseBody.basemap, false);
});

test("courier assignments keep Shipway aggregator and actual carrier distinct", () => {
  assert.deepEqual(normalizeCourierAssignment({ provider: "Shipway", carrier_name: "Ekart", carrier_id: "EKT-1" }), {
    provider: "Shipway", carrierName: "Ekart", carrierId: "EKT-1",
  });
  assert.deepEqual(normalizeCourierAssignment({ provider: "India Post" }), {
    provider: "IndiaPost", carrierName: "India Post", carrierId: null,
  });
  assert.throws(() => normalizeCourierAssignment({ provider: "Delhivery", carrier_name: "India Post" }), /matching/);
});
