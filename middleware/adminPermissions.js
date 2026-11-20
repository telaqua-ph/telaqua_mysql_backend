import { query } from "../config/db.js";

/**
 * Permissions are deliberately looked up for every request instead of being
 * placed in a long-lived JWT. Revoking access therefore takes effect at once.
 */
export function requireFarmerIntelAccess({ customerData = false } = {}) {
  return async (req, res, next) => {
    const adminId = Number(req.admin?.id ?? req.user?.admin_id);
    if (!Number.isInteger(adminId) || adminId < 1) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    try {
      const { rows } = await query(
        `SELECT can_view_farmer_intel_map, can_view_customer_data, can_manage_couriers
         FROM admin_permissions WHERE admin_id = ? LIMIT 1`,
        [adminId]
      );
      const permissions = rows[0];
      if (!permissions || !Number(permissions.can_view_farmer_intel_map) ||
          (customerData && !Number(permissions.can_view_customer_data))) {
        return res.status(403).json({ success: false, message: "You do not have permission to access Farmer Intel Map." });
      }
      req.farmerIntelPermissions = {
        canViewCustomerData: Boolean(Number(permissions.can_view_customer_data)),
        canManageCouriers: Boolean(Number(permissions.can_manage_couriers)),
      };
      return next();
    } catch (error) {
      if (error?.code === "ER_NO_SUCH_TABLE") {
        return res.status(503).json({ success: false, message: "Farmer Intel Map migration is required." });
      }
      return next(error);
    }
  };
}
