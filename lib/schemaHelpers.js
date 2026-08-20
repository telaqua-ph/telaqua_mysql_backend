/**
 * MySQL schema introspection helpers (read-only / idempotent DDL).
 */

import { query } from "../config/db.js";

export async function columnExists(table, column) {
  const { rows } = await query(
    `SELECT 1 AS ok
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

export async function ensureColumn(table, column, ddl) {
  if (await columnExists(table, column)) return;
  await query(ddl);
}
