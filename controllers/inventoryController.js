/**
 * Admin inventory management API.
 */

import {
  addStock,
  adjustStock,
  getInventoryHistory,
  getInventorySummary,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  updateLowStockThreshold,
} from "../services/inventoryService.js";
import { isMissingTableError } from "../lib/dbErrors.js";

function adminId(req) {
  const id = Number(req.user?.admin_id ?? req.user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function getInventory(req, res) {
  try {
    const data = await getInventorySummary();
    return res.status(200).json({ success: true, ...data });
  } catch (err) {
    console.error("GET inventory error:", err?.message);
    if (isMissingTableError(err)) {
      return res.status(503).json({
        success: false,
        message: "Inventory tables missing. Run sql/add_inventory.sql",
      });
    }
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getHistory(req, res) {
  try {
    const sku = String(req.query.sku || "").trim() || undefined;
    const limit = Number(req.query.limit);
    const offset = Number(req.query.offset);
    const history = await getInventoryHistory({ sku, limit, offset });
    return res.status(200).json({ success: true, history });
  } catch (err) {
    console.error("GET inventory history error:", err?.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function postAddStock(req, res) {
  try {
    const body = req.body || {};
    const quantity = Number(body.quantity);
    const reason = String(body.reason || "").trim();
    const sku = String(body.sku || "").trim() || undefined;

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be a positive integer",
      });
    }
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "Reason is required",
      });
    }

    const result = await addStock({
      sku,
      quantity,
      reason,
      adminId: adminId(req),
    });

    return res.status(200).json({
      success: true,
      message: "Stock added successfully",
      inventory: result,
    });
  } catch (err) {
    console.error("POST add stock error:", err?.message);
    if (err?.message === "REASON_REQUIRED") {
      return res.status(400).json({ success: false, message: "Reason is required" });
    }
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function postAdjustStock(req, res) {
  try {
    const body = req.body || {};
    const quantityChange = Number(body.quantity_change ?? body.quantityChange);
    const transactionType = String(
      body.transaction_type || body.transactionType || "ADJUSTMENT"
    ).trim();
    const reason = String(body.reason || "").trim();
    const sku = String(body.sku || "").trim() || undefined;

    if (!Number.isInteger(quantityChange) || quantityChange === 0) {
      return res.status(400).json({
        success: false,
        message: "quantity_change must be a non-zero integer",
      });
    }
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "Reason is required",
      });
    }

    const result = await adjustStock({
      sku,
      quantityChange,
      transactionType,
      reason,
      adminId: adminId(req),
    });

    return res.status(200).json({
      success: true,
      message: "Stock adjusted successfully",
      inventory: result,
    });
  } catch (err) {
    console.error("POST adjust stock error:", err?.message);
    if (err?.message === "INSUFFICIENT_STOCK") {
      return res.status(409).json({
        success: false,
        message: "Adjustment would make stock negative",
      });
    }
    if (err?.message === "INVENTORY_NOT_FOUND") {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function patchThreshold(req, res) {
  try {
    const sku = String(req.params.sku || "").trim();
    const threshold = Number(req.body?.threshold ?? req.body?.low_stock_threshold);
    if (!sku) {
      return res.status(400).json({ success: false, message: "SKU is required" });
    }
    if (!Number.isInteger(threshold) || threshold < 0) {
      return res.status(400).json({
        success: false,
        message: "Threshold must be a non-negative integer",
      });
    }

    const row = await updateLowStockThreshold({ sku, threshold });
    return res.status(200).json({
      success: true,
      message: "Threshold updated",
      inventory: row,
    });
  } catch (err) {
    console.error("PATCH threshold error:", err?.message);
    if (err?.message === "INVENTORY_NOT_FOUND") {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getNotifications(req, res) {
  try {
    const unreadOnly = String(req.query.unread || "").toLowerCase() === "true";
    const data = await listNotifications({ unreadOnly });
    return res.status(200).json({ success: true, ...data });
  } catch (err) {
    console.error("GET notifications error:", err?.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function patchNotificationRead(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid notification id" });
    }
    const row = await markNotificationRead(id);
    if (!row) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    return res.status(200).json({ success: true, notification: row });
  } catch (err) {
    console.error("PATCH notification error:", err?.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function patchNotificationsReadAll(req, res) {
  try {
    await markAllNotificationsRead();
    return res.status(200).json({ success: true, message: "All notifications marked read" });
  } catch (err) {
    console.error("PATCH notifications read-all error:", err?.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getPublicStock(req, res) {
  try {
    const { getAvailableStock, DEFAULT_PRODUCT_SKU } = await import(
      "../services/inventoryService.js"
    );
    const available = await getAvailableStock(DEFAULT_PRODUCT_SKU);
    if (available === null) {
      return res.status(200).json({
        success: true,
        sku: DEFAULT_PRODUCT_SKU,
        available: null,
        inventory_configured: false,
      });
    }
    return res.status(200).json({
      success: true,
      sku: DEFAULT_PRODUCT_SKU,
      available,
      inventory_configured: true,
    });
  } catch (err) {
    console.error("GET public stock error:", err?.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}
