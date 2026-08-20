/**
 * Temporary read-only Hostinger MySQL connection diagnostic.
 * Usage: node test-hostinger-db.js
 *
 * Safe: SELECT / SHOW only — no writes, no DDL, no secrets logged.
 */

import "dotenv/config";
import mysql from "mysql2/promise";

const REQUIRED_TABLES = [
  "admin_notifications",
  "admin_order_views",
  "admins",
  "contact_messages",
  "customer_auth_otps",
  "customer_sessions",
  "inventory",
  "inventory_history",
  "orders",
  "promo_codes",
  "razorpay_webhook_events",
];

function mask(value) {
  if (!value) return "(not set)";
  const s = String(value);
  if (s.length <= 4) return "****";
  return `${s.slice(0, 3)}***`;
}

function envSummary() {
  return {
    DB_HOST: mask(process.env.DB_HOST),
    DB_PORT: process.env.DB_PORT || "(default 3306)",
    DB_NAME: mask(process.env.DB_NAME),
    DB_USER: mask(process.env.DB_USER),
    DB_PASSWORD: process.env.DB_PASSWORD ? "(set)" : "(not set)",
  };
}

function classifyError(err) {
  const code = err?.code || "UNKNOWN";
  const errno = err?.errno;
  const message = String(err?.message || err || "Unknown error");

  if (code === "ER_ACCESS_DENIED_ERROR" || errno === 1045) {
    if (/Access denied for user/i.test(message) && /to database/i.test(message)) {
      return {
        type: "database user does not have access to database",
        action:
          "In Hostinger hPanel, confirm the MySQL user is assigned to the correct database with sufficient privileges.",
      };
    }
    return {
      type: "invalid username/password",
      action:
        "Verify DB_USER and DB_PASSWORD in your local .env match the MySQL user credentials in Hostinger hPanel.",
    };
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      type: "hostname/DNS problem",
      action:
        "Confirm DB_HOST is correct (e.g. srv982.hstgr.io). Try resolving the hostname from your network.",
    };
  }

  if (code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "EHOSTUNREACH") {
    return {
      type: "port/network connection problem",
      action:
        "Confirm DB_PORT is 3306, your firewall allows outbound MySQL, and Hostinger remote MySQL is enabled.",
    };
  }

  if (code === "ER_BAD_DB_ERROR" || errno === 1049) {
    return {
      type: "database does not exist",
      action:
        "Confirm DB_NAME matches the exact database name shown in Hostinger hPanel.",
    };
  }

  if (code === "ER_HOST_NOT_PRIVILEGED" || code === "ER_HOST_IS_BLOCKED") {
    return {
      type: "IP not allowlisted",
      action:
        "In Hostinger hPanel → Databases → Remote MySQL, add your current public IP address.",
    };
  }

  if (/connect ETIMEDOUT/i.test(message) || /Too many connections/i.test(message)) {
    return {
      type: "remote MySQL access disabled",
      action:
        "Enable remote MySQL in Hostinger and allowlist your client IP. Some plans require explicit remote access setup.",
    };
  }

  return {
    type: "other MySQL authentication/connection error",
    action:
      "Review Hostinger MySQL settings: remote access, user privileges, host, port, and database name.",
  };
}

async function main() {
  const host = (process.env.DB_HOST || "").trim();
  const database = (process.env.DB_NAME || "").trim();
  const user = (process.env.DB_USER || "").trim();
  const password = process.env.DB_PASSWORD ?? "";
  const port = Number(process.env.DB_PORT || 3306);

  console.log("=== Hostinger MySQL Connection Test (read-only) ===");
  console.log("Environment (masked):", envSummary());

  if (!host || !database || !user) {
    console.log("\nHOSTINGER MYSQL CONNECTION: FAILED");
    console.log("DATABASE: NOT CONNECTED");
    console.log("Reason: DB_HOST, DB_NAME, and DB_USER must be set in .env");
    process.exitCode = 1;
    return;
  }

  if (!password) {
    console.log("\nHOSTINGER MYSQL CONNECTION: FAILED");
    console.log("DATABASE: NOT CONNECTED");
    console.log("Reason: DB_PASSWORD is not set in .env");
    process.exitCode = 1;
    return;
  }

  let connection;

  const results = {
    select1: "FAIL",
    showTables: "FAIL",
    ordersRead: "FAIL",
    requiredTablesVisible: 0,
    totalOrders: null,
    tableNames: [],
  };

  try {
    connection = await mysql.createConnection({
      host,
      port,
      database,
      user,
      password,
      connectTimeout: 15000,
    });

    console.log("\nConnection established.");

    const [selectRows] = await connection.execute("SELECT 1 AS test");
    if (selectRows?.[0]?.test === 1) {
      results.select1 = "PASS";
      console.log("SELECT 1: PASS");
    } else {
      console.log("SELECT 1: FAIL (unexpected result)");
    }

    const [tableRows] = await connection.execute("SHOW TABLES");
    results.showTables = "PASS";
    results.tableNames = tableRows.map((row) => Object.values(row)[0]);
    console.log(`SHOW TABLES: PASS (${results.tableNames.length} tables found)`);

    const [orderRows] = await connection.execute(
      "SELECT COUNT(*) AS total_orders FROM orders"
    );
    results.ordersRead = "PASS";
    results.totalOrders = Number(
      orderRows[0]?.total_orders ?? orderRows[0]?.TOTAL_ORDERS ?? 0
    );
    console.log(`ORDERS TABLE READ: PASS (total_orders = ${results.totalOrders})`);

    const tableSet = new Set(results.tableNames.map((t) => String(t).toLowerCase()));
    for (const name of REQUIRED_TABLES) {
      if (tableSet.has(name.toLowerCase())) {
        results.requiredTablesVisible += 1;
      }
    }

    console.log(
      `Required tables visible: ${results.requiredTablesVisible} / ${REQUIRED_TABLES.length}`
    );

    const missing = REQUIRED_TABLES.filter((t) => !tableSet.has(t.toLowerCase()));
    if (missing.length > 0) {
      console.log("Missing required tables:", missing.join(", "));
    } else {
      console.log("All 11 required tables are present.");
    }

    console.log("\nHOSTINGER MYSQL CONNECTION: SUCCESS");
    console.log("DATABASE: CONNECTED");
    console.log(`SELECT 1: ${results.select1}`);
    console.log(`SHOW TABLES: ${results.showTables}`);
    console.log(`ORDERS TABLE READ: ${results.ordersRead}`);
    console.log(
      `Required tables visible: ${results.requiredTablesVisible} / ${REQUIRED_TABLES.length}`
    );
    console.log("\nHOSTINGER MYSQL IS ACCESSIBLE FROM LOCAL BACKEND.");
  } catch (err) {
    const diagnosis = classifyError(err);

    console.log("\nHOSTINGER MYSQL CONNECTION: FAILED");
    console.log("DATABASE: NOT CONNECTED");
    console.log(`SELECT 1: ${results.select1}`);
    console.log(`SHOW TABLES: ${results.showTables}`);
    console.log(`ORDERS TABLE READ: ${results.ordersRead}`);
    console.log(
      `Required tables visible: ${results.requiredTablesVisible} / ${REQUIRED_TABLES.length}`
    );
    console.log("\n--- Safe diagnostic ---");
    console.log("Error code:", err?.code || "(none)");
    console.log("Error errno:", err?.errno ?? "(none)");
    console.log("Error type:", diagnosis.type);
    console.log("Safe message:", String(err?.message || err).replace(/password[^\s]*/gi, "[redacted]"));
    console.log("Recommended Hostinger action:", diagnosis.action);
    console.log("\nHOSTINGER MYSQL CONNECTION IS NOT YET AVAILABLE.");
    process.exitCode = 1;
  } finally {
    if (connection) {
      await connection.end().catch(() => {});
    }
  }
}

main();
