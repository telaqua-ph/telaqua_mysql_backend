import assert from "node:assert/strict";
import test from "node:test";
import { lookupPincode, runPincodeGeocodeSync, savePincodeGeocode } from "../services/pincodeGeocodeService.js";

const noPause = async () => {};
const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("pincode found directly uses the pincode centroid", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return jsonResponse([{ lat: "17.4485", lon: "78.3908", address: { state: "Telangana", state_district: "Rangareddy" } }]);
  };
  const result = await lookupPincode({ pincode: "500081", city: "Hyderabad", state: "Telangana" }, { fetchFn, pause: noPause });
  assert.equal(result.source, "nominatim:pincode");
  assert.equal(result.latitude, 17.4485);
  assert.equal(result.district, "Rangareddy");
  assert.match(calls[0], /postalcode=500081/);
  assert.match(calls[0], /countrycodes=in/);
});

test("falls back to the order city when the pincode is unknown", async () => {
  let call = 0;
  const fetchFn = async () => (call++ === 0 ? jsonResponse([]) : jsonResponse([{ lat: "24.17", lon: "72.43", address: { state: "Gujarat" } }]));
  const result = await lookupPincode({ pincode: "385310", city: "Banaskantha", state: "Gujarat" }, { fetchFn, pause: noPause });
  assert.equal(result.source, "nominatim:city-centroid");
  assert.equal(result.district, "Banaskantha");
});

test("results outside India are rejected", async () => {
  const fetchFn = async () => jsonResponse([{ lat: "51.5", lon: "-0.12", address: {} }]);
  const result = await lookupPincode({ pincode: "110001", city: "", state: "" }, { fetchFn, pause: noPause });
  assert.equal(result.notFound, true);
});

test("sync saves coordinates for missing pincodes and stops on rate limit", async () => {
  const saved = [];
  const db = {
    query: async (sql, params) => {
      if (/FROM orders o/.test(sql)) return { rows: [{ pincode: "500081", city: "Hyderabad", state: "Telangana" }, { pincode: "533002", city: "Kakinada", state: "Andhra Pradesh" }] };
      if (/INSERT INTO pincode_geocodes/.test(sql)) { saved.push(params); return { rows: [] }; }
      return { rows: [] };
    },
  };
  let call = 0;
  const fetchFn = async () => (call++ === 0
    ? jsonResponse([{ lat: "17.4", lon: "78.4", address: { state: "Telangana" } }])
    : jsonResponse([], 429));
  const summary = await runPincodeGeocodeSync({ db, fetchFn, pause: noPause, env: {} });
  assert.equal(summary.added, 1);
  assert.equal(summary.failed, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0], "500081");
});

test("not-found pincodes are stored without coordinates so they are retried later", async () => {
  const saved = [];
  const db = { query: async (sql, params) => { saved.push(params); return { rows: [] }; } };
  await savePincodeGeocode(db, "999999", { notFound: true });
  assert.equal(saved[0][3], null);
  assert.equal(saved[0][5], "nominatim:not-found");
});
