/**
 * routes/orders.js
 */

import { Router } from "express";
import {
  listOrders,
  exportOrders,
  createOrder,
  createManualCodOrder,
  createWebsiteCodOrder,
  collectCodPayment,
  collectBulkCodPayments,
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
import {
  getOrderDeliveryDetailsHistory,
  updateOrderDeliveryDetails,
} from "../controllers/orderDeliveryDetailsController.js";
import { requireAuth } from "../middleware/auth.js";
import { requireActiveAdmin } from "../middleware/requireActiveAdmin.js";

const router = Router();

router.get("/", requireAuth, listOrders);
router.post("/export", requireAuth, exportOrders);
router.post("/", createOrder);
router.post("/website-cod", createWebsiteCodOrder);
router.post("/manual-cod", requireAuth, createManualCodOrder);
router.patch("/cod-payment/bulk", requireAuth, collectBulkCodPayments);
router.post("/:id/mark-seen", requireAuth, markOrderSeen);
router.post("/reconcile-razorpay", requireAuth, reconcileRazorpayPayment);
router.post("/reconcile-pending-razorpay", requireAuth, reconcilePendingRazorpayPayments);
router.post("/:orderId/invoice", requireAuth, processOrderInvoice);
router.post("/:orderId/retry-invoice", requireAuth, processOrderInvoice);
router.post("/:orderId/invoice/refresh-hsn", requireAuth, refreshOrderInvoiceHsn);
router.get("/:orderId/invoice/download", requireAuth, downloadOrderInvoice);
router.get("/:id/delivery-details/history", requireAuth, requireActiveAdmin, getOrderDeliveryDetailsHistory);
router.patch("/:id/delivery-details", requireAuth, requireActiveAdmin, updateOrderDeliveryDetails);
router.get("/:id", getOrderById);
router.patch("/:id/cod-payment", requireAuth, collectCodPayment);
router.put("/:id", requireAuth, updateOrder);
router.delete("/:id", requireAuth, deleteOrder);

export default router;
