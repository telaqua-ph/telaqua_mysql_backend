import { query } from "../config/db.js";
import {
  FARMER_INTEL_TOKEN_HEADER,
  findActiveFarmerIntelUser,
  verifyFarmerIntelToken,
} from "../services/farmerIntelAuth.js";

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

/**
 * Second lock for the Farmer Intel Map. Runs after the normal admin login check.
 * The request must also carry a valid Farmer Intel token (separate email + password)
 * issued to this same admin session. 403 (not 401) so the admin is not logged out.
 */
export function requireFarmerIntelLogin() {
  return async (req, res, next) => {
    const lockedResponse = (message) => res.status(403).json({
      success: false,
      code: "FARMER_INTEL_LOGIN_REQUIRED",
      message,
    });
    const raw = String(req.headers[FARMER_INTEL_TOKEN_HEADER] || "").trim();
    if (!raw) return lockedResponse("Farmer Intel Map is locked. Sign in with your Farmer Intel email and password.");
    let payload;
    try {
      payload = verifyFarmerIntelToken(raw);
    } catch {
      return lockedResponse("Your Farmer Intel session has expired. Please sign in again.");
    }
    const adminId = Number(req.admin?.id ?? req.user?.admin_id);
    if (Number(payload.admin_id) !== adminId) {
      return lockedResponse("Farmer Intel session does not belong to this admin login. Please sign in again.");
    }
    try {
      const user = await findActiveFarmerIntelUser(payload.fi_user_id);
      if (!user) return lockedResponse("This Farmer Intel login is no longer active.");
      req.farmerIntelPermissions = {
        canViewCustomerData: Boolean(Number(user.can_view_customer_data)),
        canManageCouriers: Boolean(Number(user.can_manage_couriers)),
      };
      req.farmerIntelUser = { id: user.id, email: user.email };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/** True only when the separate Farmer Intel email/password lock is switched on (FARMER_INTEL_LOGIN_REQUIRED=true). */
export function farmerIntelLoginRequired(env = process.env) {
  return String(env.FARMER_INTEL_LOGIN_REQUIRED || "").trim().toLowerCase() === "true";
}

/**
 * Farmer Intel Map access.
 * Default: any logged-in, active admin can open the map (no second login), with full access.
 * Set FARMER_INTEL_LOGIN_REQUIRED=true to bring back the separate Farmer Intel login.
 */
export function farmerIntelAccess() {
  const loginGate = requireFarmerIntelLogin();
  return (req, res, next) => {
    if (farmerIntelLoginRequired()) return loginGate(req, res, next);
    req.farmerIntelPermissions = { canViewCustomerData: true, canManageCouriers: true };
    return next();
  };
}
