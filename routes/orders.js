/**
 * routes/orders.js
 */

import { Router } from "express";
import {
  listOrders,
  createOrder,
  createManualCodOrder,
  collectCodPayment,
  getOrderById,
  updateOrder,
  deleteOrder,
  markOrderSeen,
  reconcileRazorpayPayment,
  reconcilePendingRazorpayPayments,
} from "../controllers/orderController.js";
import {
  downloadOrderInvoice,
  processOrderInvoice,
  refreshOrderInvoiceHsn,
} from "../controllers/invoiceController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/", requireAuth, listOrders);
router.post("/", createOrder);
router.post("/manual-cod", requireAuth, createManualCodOrder);
router.post("/:id/mark-seen", requireAuth, markOrderSeen);
router.post("/reconcile-razorpay", requireAuth, reconcileRazorpayPayment);
router.post("/reconcile-pending-razorpay", requireAuth, reconcilePendingRazorpayPayments);
router.post("/:orderId/invoice", requireAuth, processOrderInvoice);
router.post("/:orderId/retry-invoice", requireAuth, processOrderInvoice);
router.post("/:orderId/invoice/refresh-hsn", requireAuth, refreshOrderInvoiceHsn);
router.get("/:orderId/invoice/download", requireAuth, downloadOrderInvoice);
router.get("/:id", getOrderById);
router.patch("/:id/cod-payment", requireAuth, collectCodPayment);
router.put("/:id", requireAuth, updateOrder);
router.delete("/:id", requireAuth, deleteOrder);

export default router;
