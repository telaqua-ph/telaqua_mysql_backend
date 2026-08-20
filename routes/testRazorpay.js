/**
 * routes/testRazorpay.js
 *
 * Thin aliases for the isolated ₹1 LIVE Razorpay test flow.
 * Reuses the same handlers as /api/payment/create-test-order + verify-payment.
 * Does NOT create a second Razorpay integration.
 */

import { Router } from "express";
import {
  createTestPaymentOrder,
  verifyPayment,
} from "../controllers/paymentController.js";

const router = Router();

/** POST /api/test/razorpay/order */
router.post("/order", createTestPaymentOrder);

/** POST /api/test/razorpay/verify */
router.post("/verify", verifyPayment);

export default router;
