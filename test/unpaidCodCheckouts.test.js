import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../config/db.js";
import { listUnpaidCodCheckouts } from "../services/codAdvanceService.js";

test("unpaid COD checkouts: one latest row per phone, JSON nulls cleaned", async () => {
  const original = pool.query;
  let seenSql = "";
  pool.query = async (sql) => {
    seenSql = String(sql);
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
  } finally {
    pool.query = original;
  }
});
