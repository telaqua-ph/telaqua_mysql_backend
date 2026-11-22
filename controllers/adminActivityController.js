/**
 * controllers/adminActivityController.js
 *
 * Read-only API for the admin Activity Log page and the per-order history box.
 * Nobody can edit or delete log rows through the API.
 */

import {
  canViewActivityLog,
  listActions,
  listActivity,
  listAdminsForFilter,
  orderActivity,
} from "../services/adminActivityLog.js";

/** Middleware: only admins listed in ACTIVITY_LOG_VIEWERS (or everyone when it is empty). */
export function requireActivityLogViewer(req, res, next) {
  if (canViewActivityLog(req.admin)) return next();
  return res.status(403).json({
    success: false,
    code: "ACTIVITY_LOG_FORBIDDEN",
    message: "You do not have access to the Activity Log.",
  });
}

export function getActivityAccess(req, res) {
  return res.status(200).json({ success: true, data: { canView: canViewActivityLog(req.admin) } });
}

export async function getActivityLog(req, res) {
  try {
    const result = await listActivity({
      adminId: req.query.admin_id,
      action: req.query.action,
      order: req.query.order,
      orderId: req.query.order_id,
      q: req.query.q,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.status(200).json({
      success: true,
      data: result.rows,
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  } catch (error) {
    console.error("Activity log list failed:", error?.message);
    return res.status(500).json({ success: false, message: "Could not load the activity log." });
  }
}

export async function getActivityFilters(req, res) {
  try {
    const [admins, actions] = await Promise.all([listAdminsForFilter(), listActions()]);
    return res.status(200).json({ success: true, data: { admins, actions } });
  } catch (error) {
    console.error("Activity log filters failed:", error?.message);
    return res.status(500).json({ success: false, message: "Could not load filters." });
  }
}

export async function getOrderActivity(req, res) {
  try {
    const rows = await orderActivity(req.params.orderId);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Order activity failed:", error?.message);
    return res.status(500).json({ success: false, message: "Could not load order history." });
  }
}
