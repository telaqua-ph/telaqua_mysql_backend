import assert from "node:assert/strict";
import test from "node:test";

import {
  createShipment,
  getExpectedTat,
  getShippingRate,
} from "../services/delhiveryService.js";

const originalFetch = globalThis.fetch;

function withDelhiveryEnv(urlKey, url, callback) {
  const saved = {
    DELHIVERY_API_TOKEN: process.env.DELHIVERY_API_TOKEN,
    DELHIVERY_ENV: process.env.DELHIVERY_ENV,
    [urlKey]: process.env[urlKey],
  };
  process.env.DELHIVERY_API_TOKEN = "test-token";
  process.env.DELHIVERY_ENV = "staging";
  process.env[urlKey] = url;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test.after(() => {
  globalThis.fetch = originalFetch;
});

test("shipment creation sends Express in the form-encoded data for new orders", async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ packages: [{ waybill: "61112610001116" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await withDelhiveryEnv(
    "DELHIVERY_STAGING_SHIPMENT_CREATE_URL",
    "https://staging.example.test/waybill/api/batches/json/",
    async () => {
      await createShipment({
        pickup_location: { name: "Tel-Aqua" },
        shipments: [{ order: "TAQ-000368", payment_mode: "Pre-paid", shipping_mode: "Express" }],
      });
    }
  );

  assert.equal(request.options.headers["Content-Type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(request.options.body);
  assert.equal(form.get("format"), "json");
  assert.equal(JSON.parse(form.get("data")).shipments[0].shipping_mode, "Express");
});

test("TAT and rate requests use Delhivery's Express code E", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ tat: 2, total_amount: 100 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await withDelhiveryEnv(
    "DELHIVERY_STAGING_TAT_URL",
    "https://staging.example.test/tat",
    async () => {
      await getExpectedTat({ origin_pin: "500081", destination_pin: "524127", mot: "S" });
    }
  );
  await withDelhiveryEnv(
    "DELHIVERY_STAGING_RATE_URL",
    "https://staging.example.test/rate",
    async () => {
      await getShippingRate({ md: "S", cgm: 300, o_pin: "500081", d_pin: "524127", ss: "Delivered" });
    }
  );

  assert.equal(new URL(urls[0]).searchParams.get("mot"), "E");
  assert.equal(new URL(urls[1]).searchParams.get("md"), "E");
});

test("shipment creation exposes provider rejection without a Surface retry", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: "Express is not enabled" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };

  await assert.rejects(
    withDelhiveryEnv(
      "DELHIVERY_STAGING_SHIPMENT_CREATE_URL",
      "https://staging.example.test/waybill/api/batches/json/",
      () => createShipment({ shipments: [{ shipping_mode: "Express" }] })
    ),
    /Express is not enabled/
  );
  assert.equal(attempts, 1);
});