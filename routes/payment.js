/**
 * routes/payment.js
 */

import { Router } from "express";
import {
  createPaymentOrder,
  createTestPaymentOrder,
  downloadCustomerInvoice,
  getInvoiceStatus,
  verifyPayment,
} from "../controllers/paymentController.js";

const router = Router();

router.post("/create-order", createPaymentOrder);
/** Hidden ₹1 LIVE Razorpay test — reuses same client + verify-payment */
router.post("/create-test-order", createTestPaymentOrder);
router.post("/verify-payment", verifyPayment);
router.post("/invoice-status", getInvoiceStatus);
router.get("/invoice-download", downloadCustomerInvoice);

export default router;
