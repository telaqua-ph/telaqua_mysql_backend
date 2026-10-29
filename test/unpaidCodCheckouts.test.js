import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../config/db.js";
import { dismissUnpaidCodCheckout, leadsStartEpochSeconds, listUnpaidCodCheckouts } from "../services/codAdvanceService.js";

test("unpaid COD checkouts: one latest row per phone, JSON nulls cleaned", async () => {
  const original = pool.query;
  let seenSql = "";
  let seenParams = [];
  pool.query = async (sql, params) => {
    seenSql = String(sql);
    seenParams = params;
    // Rows arrive newest first, as the SQL orders them.
    return {
      rows: [
        { id: 9, status: "created", product_amount: "1799.00", customer_name: "Asha", phone: "9876543210", email: "null", address: "12 Lake Rd", city: "Eluru", state: "AP", pincode: "534001", quantity: "1", promo_code: "null", created_at: "2026-10-29 10:00:00" },
        { id: 7, status: "failed", product_amount: "1799.00", customer_name: "Asha", phone: "9876543210", email: "", address: "old", city: "Eluru", state: "AP", pincode: "534001", quantity: "1", promo_code: null, created_at: "2026-10-28 10:00:00" },
        { id: 5, status: "created", product_amount: "3598.00", customer_name: "Ravi", phone: "9123456780", email: "r@x.in", address: "Main St", city: "Guntur", state: "AP", pincode: "522001", quantity: "2", promo_code: "TA40", created_at: "2026-10-27 10:00:00" },
      ],
    };
  };
  try {
    const rows = await listUnpaidCodCheckouts();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.id), [9, 5]);
    assert.equal(rows[0].email, "");
    assert.equal(rows[0].promo_code, "");
    assert.equal(rows[0].product_amount, 1799);
    assert.equal(rows[1].quantity, 2);
    assert.match(seenSql, /order_id IS NULL/);
    assert.match(seenSql, /status IN \('created', 'failed'\)/);
    assert.match(seenSql, /NOT EXISTS/);
    assert.match(seenSql, /UNIX_TIMESTAMP\(cap.created_at\) >= \?/);
    assert.equal(seenParams[0], leadsStartEpochSeconds());
  } finally {
    pool.query = original;
  }
});

test("leads start date defaults to 29 Oct 2026 1:00 PM IST and can be overridden", () => {
  const saved = process.env.LEADS_START_AT;
  try {
    delete process.env.LEADS_START_AT;
    assert.equal(leadsStartEpochSeconds(), Date.parse("2026-10-29T07:30:00Z") / 1000);
    process.env.LEADS_START_AT = "2026-11-01T00:00:00+05:30";
    assert.equal(leadsStartEpochSeconds(), Date.parse("2026-10-31T18:30:00Z") / 1000);
    process.env.LEADS_START_AT = "not a date";
    assert.equal(leadsStartEpochSeconds(), Date.parse("2026-10-29T07:30:00Z") / 1000);
  } finally {
    if (saved === undefined) delete process.env.LEADS_START_AT;
    else process.env.LEADS_START_AT = saved;
  }
});

test("deleting a lead soft-dismisses it and older unpaid attempts from the same phone", async () => {
  const original = pool.query;
  const calls = [];
  pool.query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    calls.push({ s, params });
    if (s.startsWith("SELECT id")) return { rows: params[0] === 9 ? [{ id: 9, phone: "9876543210" }] : [] };
    if (s.startsWith("UPDATE")) return { rows: [], affectedRows: 2 };
    throw new Error("unexpected " + s);
  };
  try {
    assert.equal(await dismissUnpaidCodCheckout(9), 2);
    const update = calls.find((c) => c.s.startsWith("UPDATE"));
    assert.match(update.s, /SET status = 'dismissed'/);
    assert.match(update.s, /order_id IS NULL/);
    assert.doesNotMatch(update.s, /DELETE/);
    assert.deepEqual(update.params, [9, 9, "9876543210"]);
    assert.equal(await dismissUnpaidCodCheckout(404), 0);
    assert.equal(await dismissUnpaidCodCheckout("abc"), 0);
  } finally {
    pool.query = original;
  }
});
