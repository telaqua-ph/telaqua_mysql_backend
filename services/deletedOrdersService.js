/**
 * services/deletedOrdersService.js
 *
 * Archive of orders deleted from the admin dashboard.
 * Before an order row is removed, a full snapshot (order + shipment rows) is saved
 * in deleted_orders so the "Deleted Orders" card, list and CSV can show it.
 * Other dashboard metrics are unaffected: they keep reading the orders table.
 */

import { query } from "../config/db.js";
import { isMissingTableError } from "../lib/dbErrors.js";

let tableReady = false;

/** Create the archive table once (idempotent). Must run outside a transaction (DDL). */
export async function ensureDeletedOrdersTable() {
  if (tableReady) return;
  await query(
    `CREATE TABLE IF NOT EXISTS deleted_orders (
       id INT AUTO_INCREMENT PRIMARY KEY,
       original_order_id INT NOT NULL,
       order_number VARCHAR(64) NULL,
       order_snapshot LONGTEXT NOT NULL,
       shipments_snapshot LONGTEXT NULL,
       deleted_by_admin_id INT NULL,
       deleted_by_email VARCHAR(255) NULL,
       deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_deleted_orders_deleted_at (deleted_at),
       INDEX idx_deleted_orders_original (original_order_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    []
  );
  tableReady = true;
}

/** Save a snapshot inside the caller's delete transaction (same client). */
export async function archiveDeletedOrder(client, { order, shipments = [], user = null }) {
  const adminId = Number(user?.admin_id ?? user?.id);
  await client.query(
    `INSERT INTO deleted_orders
       (original_order_id, order_number, order_snapshot, shipments_snapshot, deleted_by_admin_id, deleted_by_email)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      order.id,
      order.order_number || null,
      JSON.stringify(order),
      shipments.length ? JSON.stringify(shipments) : null,
      Number.isInteger(adminId) && adminId > 0 ? adminId : null,
      user?.email ? String(user.email).slice(0, 255) : null,
    ]
  );
}

function parseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

/** Deleted orders, newest first, in the same field shape as the orders API. */
export async function listDeletedOrders() {
  let rows;
  try {
    ({ rows } = await query(
      `SELECT id, original_order_id, order_number, order_snapshot, shipments_snapshot,
              deleted_by_email, deleted_at
       FROM deleted_orders
       ORDER BY deleted_at DESC, id DESC`,
      []
    ));
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return rows.map((row) => {
    const order = parseJson(row.order_snapshot, {});
    const shipments = parseJson(row.shipments_snapshot, []);
    const shipment = Array.isArray(shipments) ? shipments[0] || null : null;
    return {
      ...order,
      id: order.id ?? row.original_order_id,
      order_number: order.order_number || row.order_number,
      waybill: order.waybill || shipment?.waybill_number || null,
      shipment_status: shipment?.shipment_status || order.shipment_status || null,
      deleted_at: row.deleted_at,
      deleted_by_email: row.deleted_by_email || null,
      archive_id: row.id,
    };
  });
}

/** Count for the dashboard card. Never throws (0 when unavailable). */
export async function countDeletedOrders() {
  try {
    const { rows } = await query(`SELECT COUNT(*) AS n FROM deleted_orders`, []);
    return Number(rows[0]?.n || 0);
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.warn("Deleted orders count unavailable:", error?.message || error);
    }
    return 0;
  }
}
