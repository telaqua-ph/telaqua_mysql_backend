import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { awbFromQueryString, createTrackLinkRouter } from "../routes/trackLink.js";

function fakeDb() {
  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (text.includes("FROM shipments")) {
        if (params[0] === "SMMC1003902898") return { rows: [{ provider: "Shipway" }] };
        if (params[0] === "1490812345678") return { rows: [{ provider: null }] };
        return { rows: [] };
      }
      if (text.includes("FROM orders")) return { rows: params[0] === "1490899999999" ? [{ id: 9 }] : [] };
      throw new Error("unexpected SQL");
    },
  };
}

async function withServer(db, fn) {
  const app = express();
  app.use("/t", createTrackLinkRouter({ db }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const get = (url) => fetch(url, { redirect: "manual" });

test("base /t/ is a real 200 page (what Meta checks for the static URL)", async () => {
  await withServer(fakeDb(), async (base) => {
    for (const path of ["/t", "/t/"]) {
      const res = await get(base + path);
      assert.equal(res.status, 200, path);
      assert.match(await res.text(), /Tel-Aqua Order Tracking/);
    }
  });
});

test("/t/<AWB> redirects to the Shipway tracking page; /t/?<AWB> too", async () => {
  await withServer(fakeDb(), async (base) => {
    for (const path of ["/t/SMMC1003902898", "/t/?SMMC1003902898"]) {
      const res = await get(base + path);
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get("location"), "https://telaqua.shipway.com/tracking/forward/SMMC1003902898/");
    }
  });
});

test("older Delhivery AWBs go to Delhivery tracking", async () => {
  await withServer(fakeDb(), async (base) => {
    assert.equal((await get(base + "/t/1490812345678")).headers.get("location"), "https://www.delhivery.com/track/package/1490812345678");
    assert.equal((await get(base + "/t/1490899999999")).headers.get("location"), "https://www.delhivery.com/track/package/1490899999999");
  });
});

test("unknown or malformed AWB: friendly 404, never redirects anywhere", async () => {
  await withServer(fakeDb(), async (base) => {
    for (const path of ["/t/UNKNOWN123", "/t/ab", "/t/%3Cscript%3E", "/t/https%3A%2F%2Fevil.example"]) {
      const res = await get(base + path);
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get("location"), null, path);
    }
  });
});

test("database error shows a temporary-unavailable page", async () => {
  const db = { query: async () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); } };
  await withServer(db, async (base) => {
    assert.equal((await get(base + "/t/SMMC1003902898")).status, 503);
  });
});

test("query-string AWB parsing", () => {
  assert.equal(awbFromQueryString("/t/?SMMC1"), "SMMC1");
  assert.equal(awbFromQueryString("/t/?SMMC1&x=1"), "SMMC1");
  assert.equal(awbFromQueryString("/t/"), "");
});
