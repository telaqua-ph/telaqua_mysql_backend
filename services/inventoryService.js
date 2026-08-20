/**
 * Inventory management — stock deduction, restock, alerts, history.
 * Single-product default SKU matches storefront catalog (telaqua-ph-meter).
 */

import { pool, query } from "../config/db.js";
import { isMissingTableError } from "../lib/dbErrors.js";
import { sendInventoryAlertEmail } from "./emailService.js";

export const DEFAULT_PRODUCT_SKU = "telaqua-ph-meter";

function defaultProductName() {
  return (
    process.env.TELAQUA_PRODUCT_NAME?.trim() || "Tel-Aqua pH Meter"
  );
}

function isMissingInventoryTable(err) {
  const msg = String(err?.message || "");
  return (
    isMissingTableError(err) ||
    msg.includes("inventory") ||
    msg.includes("inventory_history")
  );
}

export function computeStockStatus(remaining, threshold) {
  const stock = Number(remaining);
  const limit = Number(threshold);
  if (!Number.isFinite(stock) || stock <= 0) return "OUT_OF_STOCK";
  if (Number.isFinite(limit) && stock <= limit) return "LOW_STOCK";
  return "IN_STOCK";
}

export function shouldTriggerLowStockAlert({
  previousStock,
  newStock,
  threshold,
  alertActive,
}) {
  if (alertActive) return false;
  const prev = Number(previousStock);
  const next = Number(newStock);
  const limit = Number(threshold);
  if (!Number.isFinite(limit) || limit < 0) return false;
  if (next <= 0) return false;
  return prev > limit && next <= limit;
}

export function shouldTriggerOutOfStockAlert({
  previousStock,
  newStock,
  alertActive,
}) {
  if (alertActive) return false;
  const prev = Number(previousStock);
  const next = Number(newStock);
  return prev > 0 && next === 0;
}

export function shouldResetLowStockAlert(newStock, threshold) {
  return Number(newStock) > Number(threshold);
}

export function shouldResetOutOfStockAlert(newStock) {
  return Number(newStock) > 0;
}

async function ensureInventoryRow(client) {
  const db = client || pool;
  const found = await db.query(
    `SELECT * FROM inventory WHERE sku = ? LIMIT 1`,
    [DEFAULT_PRODUCT_SKU]
  );
  if (found.rows[0]) return found.rows[0];

  await db.query(
    `INSERT INTO inventory (sku, product_name, current_stock, low_stock_threshold)
     VALUES (?, ?, 0, 10)
     ON DUPLICATE KEY UPDATE sku = sku`,
    [DEFAULT_PRODUCT_SKU, defaultProductName()]
  );
  const inserted = await db.query(
    `SELECT * FROM inventory WHERE sku = ? LIMIT 1`,
    [DEFAULT_PRODUCT_SKU]
  );
  return inserted.rows[0];
}

async function recordHistory(client, row) {
  await client.query(
    `INSERT INTO inventory_history (
       inventory_id, sku, quantity_change, transaction_type,
       order_id, order_number, reason, previous_stock, new_stock, admin_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.inventory_id,
      row.sku,
      row.quantity_change,
      row.transaction_type,
      row.order_id ?? null,
      row.order_number ?? null,
      row.reason ?? null,
      row.previous_stock,
      row.new_stock,
      row.admin_id ?? null,
    ]
  );
}

async function createNotification(client, row, type) {
  const isLow = type === "LOW_STOCK";
  const message = isLow
    ? `Inventory is running low. Please add new stock.`
    : `The product is out of stock. Please add new stock.`;

  await client.query(
    `INSERT INTO admin_notifications (
       notification_type, inventory_id, sku, product_name,
       stock_at_notification, threshold, message
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      type,
      row.id,
      row.sku,
      row.product_name,
      row.current_stock,
      isLow ? row.low_stock_threshold : null,
      message,
    ]
  );

  return {
    type,
    productName: row.product_name,
    sku: row.sku,
    remaining: row.current_stock,
    threshold: isLow ? row.low_stock_threshold : null,
  };
}

async function applyAlertFlags(client, inventoryRow, previousStock) {
  const pendingEmails = [];
  const prev = Number(previousStock);
  const next = Number(inventoryRow.current_stock);
  const threshold = Number(inventoryRow.low_stock_threshold);
  let lowActive = inventoryRow.low_stock_alert_active;
  let outActive = inventoryRow.out_of_stock_alert_active;

  if (shouldResetLowStockAlert(next, threshold)) {
    lowActive = false;
  }
  if (shouldResetOutOfStockAlert(next)) {
    outActive = false;
  }

  if (
    shouldTriggerOutOfStockAlert({
      previousStock: prev,
      newStock: next,
      alertActive: outActive,
    })
  ) {
    outActive = true;
    const emailPayload = await createNotification(
      client,
      inventoryRow,
      "OUT_OF_STOCK"
    );
    pendingEmails.push(emailPayload);
  } else if (
    shouldTriggerLowStockAlert({
      previousStock: prev,
      newStock: next,
      threshold,
      alertActive: lowActive,
    })
  ) {
    lowActive = true;
    const emailPayload = await createNotification(
      client,
      inventoryRow,
      "LOW_STOCK"
    );
    pendingEmails.push(emailPayload);
  }

  if (
    lowActive !== inventoryRow.low_stock_alert_active ||
    outActive !== inventoryRow.out_of_stock_alert_active
  ) {
    await client.query(
      `UPDATE inventory
       SET low_stock_alert_active = ?,
           out_of_stock_alert_active = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [lowActive ? 1 : 0, outActive ? 1 : 0, inventoryRow.id]
    );
  }

  return pendingEmails;
}

export function dispatchInventoryAlertEmails(pendingEmails = []) {
  for (const payload of pendingEmails) {
    sendInventoryAlertEmail({
      type: payload.type,
      productName: payload.productName,
      sku: payload.sku,
      remaining: payload.remaining,
      threshold: payload.threshold,
    }).catch((err) => {
      console.error("Async inventory email failed:", err?.message);
    });
  }
}

export async function getAvailableStock(sku = DEFAULT_PRODUCT_SKU) {
  try {
    const { rows } = await query(
      `SELECT current_stock FROM inventory WHERE sku = ? LIMIT 1`,
      [sku]
    );
    if (!rows[0]) return null;
    return Number(rows[0].current_stock);
  } catch (err) {
    if (isMissingInventoryTable(err)) return null;
    throw err;
  }
}

export async function assertStockAvailable(quantity, sku = DEFAULT_PRODUCT_SKU) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    return { ok: false, message: "Invalid quantity" };
  }

  try {
    const available = await getAvailableStock(sku);
    if (available === null) {
      return { ok: true, available: null, inventoryConfigured: false };
    }
    if (qty > available) {
      return {
        ok: false,
        available,
        message: `Insufficient stock. Only ${available} unit${
          available === 1 ? "" : "s"
        } available.`,
      };
    }
    return { ok: true, available, inventoryConfigured: true };
  } catch (err) {
    console.error("Stock availability check failed:", err?.message);
    return { ok: true, inventoryConfigured: false };
  }
}

async function findExistingHistory(client, orderId, transactionType) {
  const { rows } = await client.query(
    `SELECT id FROM inventory_history
     WHERE order_id = ? AND transaction_type = ?
     LIMIT 1`,
    [orderId, transactionType]
  );
  return rows[0] || null;
}

async function insertInventoryIfMissing(client, sku) {
  const inserted = await client.query(
    `INSERT INTO inventory (sku, product_name, current_stock, low_stock_threshold)
     VALUES (?, ?, 0, 10)`,
    [sku, defaultProductName()]
  );
  const { rows } = await client.query(
    `SELECT * FROM inventory WHERE id = ? LIMIT 1`,
    [inserted.insertId]
  );
  return rows[0];
}

export async function deductStockForSale(client, {
  orderId,
  orderNumber,
  quantity,
  isTestOrder = false,
}) {
  if (isTestOrder) {
    return { status: "skipped", reason: "test_order", pendingEmails: [] };
  }

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("INVALID_ORDER_QUANTITY");
  }

  const existing = await findExistingHistory(client, orderId, "SALE");
  if (existing) {
    return { status: "already_deducted", pendingEmails: [] };
  }

  const locked = await client.query(
    `SELECT * FROM inventory WHERE sku = ? FOR UPDATE`,
    [DEFAULT_PRODUCT_SKU]
  );
  let inv = locked.rows[0];
  if (!inv) {
    inv = await insertInventoryIfMissing(client, DEFAULT_PRODUCT_SKU);
  }

  if (inv.current_stock < qty) {
    return {
      status: "insufficient_stock",
      available: inv.current_stock,
      pendingEmails: [],
    };
  }

  const previousStock = inv.current_stock;
  const newStock = previousStock - qty;

  await client.query(
    `UPDATE inventory
     SET current_stock = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [newStock, inv.id]
  );

  await recordHistory(client, {
    inventory_id: inv.id,
    sku: inv.sku,
    quantity_change: -qty,
    transaction_type: "SALE",
    order_id: orderId,
    order_number: orderNumber,
    previous_stock: previousStock,
    new_stock: newStock,
  });

  const updatedRow = { ...inv, current_stock: newStock };
  const pendingEmails = await applyAlertFlags(client, updatedRow, previousStock);

  return {
    status: "deducted",
    previousStock,
    newStock,
    pendingEmails,
  };
}

export async function restoreStockForCancellation(client, {
  orderId,
  orderNumber,
  quantity,
  adminId = null,
}) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    return { status: "skipped", reason: "invalid_quantity", pendingEmails: [] };
  }

  const hadSale = await findExistingHistory(client, orderId, "SALE");
  if (!hadSale) {
    return { status: "skipped", reason: "no_prior_sale", pendingEmails: [] };
  }

  const existingRestore = await findExistingHistory(
    client,
    orderId,
    "CANCELLATION"
  );
  if (existingRestore) {
    return { status: "already_restored", pendingEmails: [] };
  }

  const locked = await client.query(
    `SELECT * FROM inventory WHERE sku = ? FOR UPDATE`,
    [DEFAULT_PRODUCT_SKU]
  );
  const inv = locked.rows[0];
  if (!inv) {
    return { status: "skipped", reason: "no_inventory", pendingEmails: [] };
  }

  const previousStock = inv.current_stock;
  const newStock = previousStock + qty;

  await client.query(
    `UPDATE inventory
     SET current_stock = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [newStock, inv.id]
  );

  await recordHistory(client, {
    inventory_id: inv.id,
    sku: inv.sku,
    quantity_change: qty,
    transaction_type: "CANCELLATION",
    order_id: orderId,
    order_number: orderNumber,
    reason: "Order cancelled",
    previous_stock: previousStock,
    new_stock: newStock,
    admin_id: adminId,
  });

  const updatedRow = { ...inv, current_stock: newStock };
  const pendingEmails = await applyAlertFlags(client, updatedRow, previousStock);

  return {
    status: "restored",
    previousStock,
    newStock,
    pendingEmails,
  };
}

async function aggregateSold(sku) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(ABS(quantity_change)), 0) AS sold
     FROM inventory_history
     WHERE sku = ? AND transaction_type = 'SALE'`,
    [sku]
  );
  return Number(rows[0]?.sold || 0);
}

async function aggregateReturns(sku) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(quantity_change), 0) AS returned
     FROM inventory_history
     WHERE sku = ? AND transaction_type IN ('CANCELLATION', 'RETURN')`,
    [sku]
  );
  return Number(rows[0]?.returned || 0);
}

export async function getInventorySummary() {
  await ensureInventoryRow(pool);
  const { rows } = await query(`SELECT * FROM inventory ORDER BY product_name ASC`);
  const items = [];
  for (const row of rows) {
    const sold = await aggregateSold(row.sku);
    const returned = await aggregateReturns(row.sku);
    const remaining = Number(row.current_stock);
    const netSold = Math.max(0, sold - returned);
    items.push({
      id: row.id,
      sku: row.sku,
      product_name: row.product_name,
      remaining,
      sold: netSold,
      total_stock: remaining + netSold,
      low_stock_threshold: row.low_stock_threshold,
      status: computeStockStatus(remaining, row.low_stock_threshold),
      low_stock_alert_active: row.low_stock_alert_active,
      out_of_stock_alert_active: row.out_of_stock_alert_active,
      updated_at: row.updated_at,
    });
  }

  const totals = items.reduce(
    (acc, item) => ({
      total_stock: acc.total_stock + item.total_stock,
      sold: acc.sold + item.sold,
      remaining: acc.remaining + item.remaining,
      low_stock_count:
        acc.low_stock_count + (item.status === "LOW_STOCK" ? 1 : 0),
    }),
    { total_stock: 0, sold: 0, remaining: 0, low_stock_count: 0 }
  );

  return { items, totals };
}

export async function getInventoryHistory({ sku, limit = 50, offset = 0 } = {}) {
  const params = [];
  let where = "";
  if (sku) {
    params.push(sku);
    where = `WHERE h.sku = ?`;
  }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  params.push(lim, off);

  const { rows } = await query(
    `SELECT h.*, a.full_name AS admin_name
     FROM inventory_history h
     LEFT JOIN admins a ON a.id = h.admin_id
     ${where}
     ORDER BY h.created_at DESC
     LIMIT ? OFFSET ?`,
    params
  );
  return rows;
}

export async function addStock({
  sku = DEFAULT_PRODUCT_SKU,
  quantity,
  reason,
  adminId,
}) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("INVALID_QUANTITY");
  }
  const note = String(reason || "").trim();
  if (!note) {
    throw new Error("REASON_REQUIRED");
  }

  const client = await pool.connect();
  let pendingEmails = [];
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT * FROM inventory WHERE sku = ? FOR UPDATE`,
      [sku]
    );
    let inv = locked.rows[0];
    if (!inv) {
      inv = await insertInventoryIfMissing(client, sku);
    }

    const previousStock = inv.current_stock;
    const newStock = previousStock + qty;

    await client.query(
      `UPDATE inventory
       SET current_stock = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [newStock, inv.id]
    );

    await recordHistory(client, {
      inventory_id: inv.id,
      sku: inv.sku,
      quantity_change: qty,
      transaction_type: "STOCK_ADDED",
      reason: note,
      previous_stock: previousStock,
      new_stock: newStock,
      admin_id: adminId,
    });

    const updatedRow = { ...inv, current_stock: newStock };
    pendingEmails = await applyAlertFlags(client, updatedRow, previousStock);
    await client.query("COMMIT");

    dispatchInventoryAlertEmails(pendingEmails);

    return {
      sku: inv.sku,
      previous_stock: previousStock,
      new_stock: newStock,
      quantity_added: qty,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function adjustStock({
  sku = DEFAULT_PRODUCT_SKU,
  quantityChange,
  transactionType = "ADJUSTMENT",
  reason,
  adminId,
}) {
  const delta = Number(quantityChange);
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error("INVALID_QUANTITY");
  }
  const type = String(transactionType || "ADJUSTMENT").toUpperCase();
  if (!["ADJUSTMENT", "DAMAGED"].includes(type)) {
    throw new Error("INVALID_TRANSACTION_TYPE");
  }
  const note = String(reason || "").trim();
  if (!note) {
    throw new Error("REASON_REQUIRED");
  }

  const client = await pool.connect();
  let pendingEmails = [];
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT * FROM inventory WHERE sku = ? FOR UPDATE`,
      [sku]
    );
    const inv = locked.rows[0];
    if (!inv) {
      throw new Error("INVENTORY_NOT_FOUND");
    }

    const previousStock = inv.current_stock;
    const newStock = previousStock + delta;
    if (newStock < 0) {
      throw new Error("INSUFFICIENT_STOCK");
    }

    await client.query(
      `UPDATE inventory
       SET current_stock = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [newStock, inv.id]
    );

    await recordHistory(client, {
      inventory_id: inv.id,
      sku: inv.sku,
      quantity_change: delta,
      transaction_type: type,
      reason: note,
      previous_stock: previousStock,
      new_stock: newStock,
      admin_id: adminId,
    });

    const updatedRow = { ...inv, current_stock: newStock };
    pendingEmails = await applyAlertFlags(client, updatedRow, previousStock);
    await client.query("COMMIT");

    dispatchInventoryAlertEmails(pendingEmails);

    return {
      sku: inv.sku,
      previous_stock: previousStock,
      new_stock: newStock,
      quantity_change: delta,
      transaction_type: type,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function updateLowStockThreshold({
  sku = DEFAULT_PRODUCT_SKU,
  threshold,
}) {
  const value = Number(threshold);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("INVALID_THRESHOLD");
  }

  await query(
    `UPDATE inventory
     SET low_stock_threshold = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE sku = ?`,
    [value, sku]
  );
  const { rows } = await query(
    `SELECT * FROM inventory WHERE sku = ? LIMIT 1`,
    [sku]
  );
  if (!rows[0]) {
    throw new Error("INVENTORY_NOT_FOUND");
  }
  return rows[0];
}

export async function listNotifications({ unreadOnly = false, limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const where = unreadOnly ? "WHERE is_read = 0" : "";

  const { rows } = await query(
    `SELECT * FROM admin_notifications
     ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
    [lim]
  );

  const countResult = await query(
    `SELECT CAST(COUNT(*) AS SIGNED) AS unread_count
     FROM admin_notifications
     WHERE is_read = 0`
  );

  return {
    notifications: rows,
    unread_count: Number(countResult.rows[0]?.unread_count || 0),
  };
}

export async function markNotificationRead(id) {
  await query(
    `UPDATE admin_notifications
     SET is_read = 1
     WHERE id = ?`,
    [id]
  );
  const { rows } = await query(
    `SELECT * FROM admin_notifications WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

export async function markAllNotificationsRead() {
  await query(`UPDATE admin_notifications SET is_read = 1 WHERE is_read = 0`);
}
