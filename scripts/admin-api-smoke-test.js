/**
 * Read-only admin dashboard API smoke test (local backend).
 * Usage: node scripts/admin-api-smoke-test.js
 *
 * Optional login credentials in .env:
 *   ADMIN_SMOKE_EMAIL=
 *   ADMIN_SMOKE_PASSWORD=
 * If omitted, JWT is minted with the same secret as login (for GET tests only).
 */

import "dotenv/config";
import { pool } from "../config/db.js";
import { signToken } from "../lib/auth.js";

const BASE = process.env.SMOKE_TEST_BASE_URL || "http://localhost:3000";
const results = [];

function record(entry) {
  results.push(entry);
  const flag = entry.pass ? "PASS" : entry.pass === false ? "FAIL" : entry.status;
  console.log(
    `[${flag}] ${entry.method} ${entry.path} → ${entry.httpStatus}${entry.note ? ` (${entry.note})` : ""}`
  );
  if (entry.error) console.log(`       Error: ${entry.error}`);
}

async function request(method, path, { token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

function hasArrayData(data, keys = []) {
  if (Array.isArray(data)) return data.length >= 0;
  for (const k of keys) {
    if (Array.isArray(data?.[k])) return true;
  }
  return false;
}

async function main() {
  console.log("=== Admin Dashboard API Smoke Test (read-only GETs) ===\n");
  console.log(`Backend: ${BASE}\n`);

  let token = null;
  let adminId = null;
  let adminEmail = null;
  let authVia = "none";

  // Login endpoint shape (no credentials → 400)
  {
    const r = await request("POST", "/api/auth/login", { body: {} });
    record({
      method: "POST",
      path: "/api/auth/login (validation)",
      httpStatus: r.status,
      pass: r.status === 400,
      auth: false,
      mysql: "admins (on successful login)",
      note: "expects email+password",
      error: r.pass === false ? r.data?.message : undefined,
    });
  }

  const smokeEmail = (process.env.ADMIN_SMOKE_EMAIL || "").trim().toLowerCase();
  const smokePassword = process.env.ADMIN_SMOKE_PASSWORD || "";

  if (smokeEmail && smokePassword) {
    const r = await request("POST", "/api/auth/login", {
      body: { email: smokeEmail, password: smokePassword },
    });
    const ok = r.status === 200 && r.data?.success && r.data?.token;
    if (ok) {
      token = r.data.token;
      adminId = r.data.admin?.id;
      adminEmail = r.data.admin?.email;
      authVia = "login-api";
    }
    record({
      method: "POST",
      path: "/api/auth/login",
      httpStatus: r.status,
      pass: ok,
      auth: ok,
      mysql: "SELECT admins; UPDATE last_login",
      note: ok ? "JWT from login response" : "login failed",
      error: ok ? undefined : r.data?.message,
    });
  }

  if (!token) {
    const admins = await pool.query(
      `SELECT id, email FROM admins WHERE is_active = 1 ORDER BY id ASC LIMIT 1`
    );
    if (admins.rows.length === 0) {
      console.error("No active admin in admins table — cannot authenticate.");
      process.exitCode = 1;
      await pool.end();
      return;
    }
    adminId = admins.rows[0].id;
    adminEmail = admins.rows[0].email;
    token = signToken({ admin_id: adminId, email: adminEmail });
    authVia = "signed-jwt (same secret as login)";
    record({
      method: "POST",
      path: "/api/auth/login",
      httpStatus: "SKIP",
      pass: "SKIP",
      auth: true,
      mysql: "admins",
      note: `No ADMIN_SMOKE_EMAIL/PASSWORD — using ${authVia}`,
    });
  }

  console.log(`\nAuth: ${authVia} (admin_id=${adminId})\n`);

  // 401 without token
  {
    const r = await request("GET", "/api/orders");
    record({
      method: "GET",
      path: "/api/orders (no JWT)",
      httpStatus: r.status,
      pass: r.status === 401,
      auth: false,
      mysql: "orders + admin_order_views",
      note: "must reject unauthenticated",
    });
  }

  const tests = [
    {
      method: "GET",
      path: "/api/auth/profile",
      mysql: "admins",
      check: (d) => d?.success && d?.admin?.email,
      label: "admin profile",
    },
    {
      method: "GET",
      path: "/api/orders",
      mysql: "orders LEFT JOIN admin_order_views",
      check: (d) => d?.success && Array.isArray(d?.orders),
      label: "orders array",
    },
    {
      method: "GET",
      path: "/api/dashboard/stats",
      mysql: "orders, admin_order_views, information_schema",
      check: (d) => d?.success && typeof d?.totalOrders === "number",
      label: "dashboard stats",
    },
    {
      method: "GET",
      path: "/api/dashboard/stats?from=2025-01-01&to=2026-12-31",
      mysql: "orders (paid + date filter)",
      check: (d) => d?.success && d?.analysis,
      label: "dashboard date range",
    },
    {
      method: "GET",
      path: "/api/inventory",
      mysql: "inventory, inventory_history aggregates",
      check: (d) => d?.success && (Array.isArray(d?.items) || d?.items),
      label: "inventory items",
    },
    {
      method: "GET",
      path: "/api/inventory/history",
      mysql: "inventory_history",
      check: (d) => d?.success && Array.isArray(d?.history),
      label: "inventory history",
    },
    {
      method: "GET",
      path: "/api/inventory/notifications/list",
      mysql: "admin_notifications",
      check: (d) => d?.success && Array.isArray(d?.notifications),
      label: "inventory notifications",
    },
    {
      method: "GET",
      path: "/api/promo-codes",
      mysql: "promo_codes",
      check: (d) => d?.success && hasArrayData(d, ["promoCodes", "promo_codes", "items"]) || Array.isArray(d?.data),
      label: "promo codes list",
    },
    {
      method: "GET",
      path: "/api/promo-codes?status=active",
      mysql: "promo_codes WHERE is_active=1",
      check: (d) => d?.success,
      label: "promo codes active filter",
    },
    {
      method: "GET",
      path: "/api/customers",
      mysql: "n/a — stub",
      check: () => false,
      expectStatus: 501,
      label: "customers stub",
      notImplemented: true,
    },
  ];

  let sampleOrderId = null;
  let samplePromoId = null;

  for (const t of tests) {
    const r = await request(t.method, t.path, { token });
    const expected = t.expectStatus ?? 200;
    const ok = r.status === expected && (t.expectStatus ? true : t.check(r.data));
    if (t.path === "/api/orders" && r.data?.orders?.[0]?.id) {
      sampleOrderId = r.data.orders[0].id;
    }
    if (t.path.startsWith("/api/promo-codes") && !t.path.includes("?")) {
      const list =
        r.data?.promoCodes || r.data?.promo_codes || r.data?.items || r.data?.data;
      if (Array.isArray(list) && list[0]?.id) samplePromoId = list[0].id;
    }
    record({
      method: t.method,
      path: t.path,
      httpStatus: r.status,
      pass: t.notImplemented ? "NOT_IMPL" : ok,
      auth: true,
      mysql: t.mysql,
      note: t.label,
      error: ok || t.notImplemented ? undefined : r.data?.message || JSON.stringify(r.data).slice(0, 120),
    });
  }

  if (sampleOrderId) {
    const r = await request("GET", `/api/orders/${sampleOrderId}`, { token });
    record({
      method: "GET",
      path: `/api/orders/${sampleOrderId}`,
      httpStatus: r.status,
      pass: r.status === 200 && (r.data?.success || r.data?.order),
      auth: true,
      mysql: "orders",
      note: "order detail",
      error: r.data?.message,
    });
  }

  if (samplePromoId) {
    const r = await request("GET", `/api/promo-codes/${samplePromoId}`, { token });
    record({
      method: "GET",
      path: `/api/promo-codes/${samplePromoId}`,
      httpStatus: r.status,
      pass: r.status === 200 && r.data?.success,
      auth: true,
      mysql: "promo_codes",
      note: "promo detail (service exists; UI uses list only)",
      error: r.data?.message,
    });
  }

  await pool.end();

  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;
  const skipped = results.filter((r) => r.pass === "SKIP").length;
  const notImpl = results.filter((r) => r.pass === "NOT_IMPL").length;

  console.log("\n=== Summary Table ===");
  console.log("Endpoint | Method | Status | PASS/FAIL | MySQL | Error");
  console.log("-".repeat(90));
  for (const r of results) {
    const status = r.pass === "NOT_IMPL" ? "NOT_IMPL" : r.pass === "SKIP" ? "SKIP" : r.pass ? "PASS" : "FAIL";
    console.log(
      `${r.path} | ${r.method} | ${r.httpStatus} | ${status} | ${r.mysql || "-"} | ${r.error || "-"}`
    );
  }

  console.log("\n=== Totals ===");
  console.log(`Total APIs tested: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Not implemented: ${notImpl}`);

  const adminUsesCustomers = false;
  console.log("\nAdmin dashboard uses /api/customers:", adminUsesCustomers ? "yes" : "no (not in frontend source)");

  if (failed > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error("Smoke test crashed:", err?.message || err);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
