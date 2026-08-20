/**
 * config/db.js
 *
 * Hostinger MySQL connection pool (mysql2/promise).
 * Uses DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD — never hardcode credentials.
 *
 * Exposes a pg-compatible query() result shape { rows, rowCount, insertId }
 * and pool.connect() for transactions (BEGIN/COMMIT/ROLLBACK translated).
 */

import mysql from "mysql2/promise";

const dbHost = (process.env.DB_HOST || "").trim();
const dbName = (process.env.DB_NAME || "").trim();
const dbUser = (process.env.DB_USER || "").trim();
const dbPassword = process.env.DB_PASSWORD ?? "";

const databaseConfigured = Boolean(dbHost && dbName && dbUser);

if (!databaseConfigured) {
  console.warn(
    "Warning: MySQL is not fully configured (DB_HOST, DB_NAME, DB_USER). Database queries will fail until set."
  );
}

const mysqlPool = mysql.createPool({
  host: dbHost || undefined,
  port: Number(process.env.DB_PORT || 3306),
  database: dbName || undefined,
  user: dbUser || undefined,
  password: dbPassword,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_MAX) || 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

function normalizeExecuteResult(result) {
  if (Array.isArray(result)) {
    return {
      rows: result,
      rowCount: result.length,
    };
  }
  return {
    rows: [],
    rowCount: result.affectedRows ?? 0,
    insertId: result.insertId,
  };
}

async function executeOn(connection, sql, params = []) {
  const [result] = await connection.execute(sql, params);
  return normalizeExecuteResult(result);
}

function wrapConnection(rawConnection) {
  return {
    async query(sql, params = []) {
      const trimmed = String(sql || "").trim().toUpperCase();
      if (trimmed === "BEGIN" || trimmed === "START TRANSACTION") {
        await rawConnection.beginTransaction();
        return { rows: [], rowCount: 0 };
      }
      if (trimmed === "COMMIT") {
        await rawConnection.commit();
        return { rows: [], rowCount: 0 };
      }
      if (trimmed === "ROLLBACK") {
        await rawConnection.rollback();
        return { rows: [], rowCount: 0 };
      }
      return executeOn(rawConnection, sql, params);
    },
    release() {
      rawConnection.release();
    },
    /** Direct mysql2 connection for advanced use */
    _raw: rawConnection,
  };
}

/**
 * Run a parameterized SQL query.
 * @param {string} text
 * @param {any[]} [params]
 */
export async function query(text, params = []) {
  if (!databaseConfigured) {
    const err = new Error("MySQL database is not configured");
    err.code = "DB_CONFIG_ERROR";
    throw err;
  }
  const [result] = await mysqlPool.execute(text, params);
  return normalizeExecuteResult(result);
}

/** pg-compatible pool facade */
export const pool = {
  async connect() {
    if (!databaseConfigured) {
      const err = new Error("MySQL database is not configured");
      err.code = "DB_CONFIG_ERROR";
      throw err;
    }
    const conn = await mysqlPool.getConnection();
    return wrapConnection(conn);
  },
  async query(text, params = []) {
    return query(text, params);
  },
  async end() {
    await mysqlPool.end();
  },
  /** Underlying mysql2 pool */
  _mysql: mysqlPool,
};

export function isDatabaseConfigured() {
  return databaseConfigured;
}
