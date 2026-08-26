import { Router } from "express";
import {
  cancelCustomerCodOrder,
  getCustomerOrder,
  getCustomerOtpProviderStatus,
  getCustomerProfile,
  getRecentCustomerOrder,
  listCustomerOrders,
  logoutCustomer,
  requestCustomerOtp,
  trackCustomerOrder,
  verifyCustomerOtp,
} from "../controllers/customerAccountController.js";
import { requireCustomerAuth } from "../middleware/customerAuth.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

router.post("/auth/request-otp", asyncRoute(requestCustomerOtp));
router.post("/auth/verify-otp", asyncRoute(verifyCustomerOtp));
router.get("/auth/interakt-status", requireAuth, asyncRoute(getCustomerOtpProviderStatus));
router.post("/auth/logout", asyncRoute(requireCustomerAuth), asyncRoute(logoutCustomer));
router.get("/profile", asyncRoute(requireCustomerAuth), asyncRoute(getCustomerProfile));
router.get("/orders", asyncRoute(requireCustomerAuth), asyncRoute(listCustomerOrders));
router.get("/orders/recent", asyncRoute(requireCustomerAuth), asyncRoute(getRecentCustomerOrder));
router.get("/orders/:orderId/tracking", asyncRoute(requireCustomerAuth), asyncRoute(trackCustomerOrder));
router.post("/orders/:orderId/cancel", asyncRoute(requireCustomerAuth), asyncRoute(cancelCustomerCodOrder));
router.get("/orders/:orderId", asyncRoute(requireCustomerAuth), asyncRoute(getCustomerOrder));

export default router;
