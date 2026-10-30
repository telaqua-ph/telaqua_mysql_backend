/**
 * Paid ₹99 COD advances must count as revenue received (Revenue page and
 * Dashboard), without double counting the product amount.
 *
 * Needs module mocking: node --experimental-test-module-mocks --test test/revenueCodAdvance.test.js
 * (skipped automatically when that flag is not set, e.g. plain `npm test`).
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";

const ORDER_COLUMNS = [
  "id", "order_number", "final_total", "total_amount", "payment_status", "payment_mode",
  "payment_method", "payment_date", "order_status", "created_at", "quantity",
  "is_test_order", "waybill", "shipment_status", "cod_advance_fee", "cod_advance_status",
  "cod_advance_verified_at",
];

if (typeof mock.module !== "function") {
  test("COD advance revenue (needs --experimental-test-module-mocks)", (t) => t.skip("module mocks not enabled"));
} else {
  await runSuite();
}

async function runSuite() {
  const calls = [];
  let reportRows = [];
  mock.module("../config/db.js", {
    namedExports: {
      query: async (sql, params = []) => {
        const text = String(sql);
        calls.push({ sql: text, params });
        if (text.includes("information_schema.COLUMNS")) {
          return { rows: ORDER_COLUMNS.map((column_name) => ({ column_name })) };
        }
        if (text.includes("information_schema.TABLES")) return { rows: [{ cnt: 1 }] };
        if (text.includes("FROM contributing")) return { rows: reportRows };
        return { rows: [{ revenue_received: "198.00", devices_sold: 0 }] };
      },
      pool: { query: async () => ({ rows: [] }) },
    },
  });

  const { getRevenueReport } = await import("../controllers/revenueController.js");
  const { getInventoryDevicesSold } = await import("../controllers/dashboardController.js");

  const placeholders = (sql) => (sql.match(/\?/g) || []).length;
  const fakeRes = () => {
    const res = { statusCode: 0, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
  };

  test("revenue report counts paid ₹99 COD advances as received (Razorpay), keeps product amount pending", async () => {
    calls.length = 0;
    reportRows = [
      { id: 1267, order_number: "TAQ-001267", amount: "99.00", payment_mode: "Razorpay", payment_status: "Advance Paid", bucket: "advance", accounting_date: "2026-10-30" },
      { id: 1266, order_number: "TAQ-001266", amount: "99.00", payment_mode: "Razorpay", payment_status: "Advance Paid", bucket: "advance", accounting_date: "2026-10-30" },
      { id: 1267, order_number: "TAQ-001267", amount: "1799.00", payment_mode: "COD", payment_status: "Pending", bucket: "pending", accounting_date: "2026-10-30" },
      { id: 1266, order_number: "TAQ-001266", amount: "1799.00", payment_mode: "COD", payment_status: "Pending", bucket: "pending", accounting_date: "2026-10-30" },
    ];
    const res = fakeRes();
    await getRevenueReport({ query: { from: "2026-10-30", to: "2026-10-30" } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.receivedRevenue, 198);
    assert.equal(res.body.codAdvanceRevenue, 198);
    assert.equal(res.body.razorpayRevenue, 198);
    assert.equal(res.body.codRevenue, 0);
    assert.equal(res.body.pendingCodRevenue, 3598);
    assert.deepEqual(res.body.daily, [{ date: "2026-10-30", amount: 198 }]);

    const report = calls.find((c) => c.sql.includes("FROM contributing"));
    assert.match(report.sql, /cod_advance_status/);
    assert.match(report.sql, /cod_advance_verified_at/);
    assert.equal(placeholders(report.sql), report.params.length);
  });

  test("dashboard stats SQL includes ₹99 advances and placeholders match params", async () => {
    calls.length = 0;
    await getInventoryDevicesSold(1);
    const stats = calls.find((c) => c.sql.includes("cod_advances AS"));
    assert.ok(stats, "dashboard query should define the cod_advances CTE");
    assert.match(stats.sql, /\+ COALESCE\(\(SELECT SUM\(advance_amount\) FROM cod_advances\), 0\)/);
    assert.equal((stats.sql.match(/FROM cod_advances/g) || []).length, 4); // all-time, today, month, range
    assert.equal(placeholders(stats.sql), stats.params.length);
  });

  test("both queries parse as MySQL", async (t) => {
    let Parser;
    try {
      const mod = await import(process.env.SQL_PARSER_PATH || "node-sql-parser");
      Parser = mod.Parser || mod.default?.Parser;
      if (!Parser) throw new Error("no parser");
    } catch {
      t.skip("node-sql-parser not installed");
      return;
    }
    const parser = new Parser();
    for (const c of calls.filter((c) => c.sql.includes("WITH "))) {
      // node-sql-parser cannot read MySQL's valid "INTERVAL (expr) DAY" (already used
      // by the month-start expression); swap that one construct before parsing.
      const sql = c.sql.replace(/INTERVAL \(DAYOFMONTH\([\s\S]*?\) - 1\) DAY/g, "INTERVAL 1 DAY");
      assert.doesNotThrow(() => parser.astify(sql, { database: "MySQL" }), c.sql.slice(0, 120));
    }
  });
}
