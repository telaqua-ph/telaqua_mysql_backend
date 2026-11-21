import { loginFarmerIntelUser } from "../services/farmerIntelAuth.js";

// Simple in-memory brute-force guard: 5 failed attempts per admin per 15 minutes.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

/** POST /api/admin/farmer-intel/login  { email, password } */
export async function farmerIntelLogin(req, res) {
  const adminId = Number(req.admin?.id ?? req.user?.admin_id);
  const key = String(adminId);
  const now = Date.now();
  const recent = (failures.get(key) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_FAILURES) {
    return res.status(429).json({ success: false, message: "Too many wrong attempts. Try again in 15 minutes." });
  }
  try {
    const result = await loginFarmerIntelUser({
      email: req.body?.email,
      password: req.body?.password,
      adminId,
    });
    if (!result) {
      failures.set(key, [...recent, now]);
      return res.status(403).json({ success: false, code: "FARMER_INTEL_LOGIN_FAILED", message: "Invalid Farmer Intel email or password." });
    }
    failures.delete(key);
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error("Farmer Intel login error:", error?.message);
    return res.status(500).json({ success: false, message: "Unable to sign in to Farmer Intel Map." });
  }
}
