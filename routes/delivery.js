/**
 * routes/delivery.js
 *
 * Delhivery B2C logistics — admin-authenticated.
 * Payment / Razorpay routes are separate and untouched.
 * See docs/DELHIVERY_FLOW.md
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  checkPincode,
  checkTat,
  fetchWaybills,
  calculateRate,
  createWarehouse,
  createShipmentForOrder,
  updateShipmentDetails,
  trackShipmentStatus,
  generateLabel,
  createPickupRequest,
  updateNdrAction,
} from "../controllers/deliveryController.js";

const router = Router();

router.use(requireAuth);

router.get("/serviceability/:pincode", checkPincode);
router.get("/tat", checkTat);
router.get("/waybill", fetchWaybills);
router.get("/rate", calculateRate);
router.post("/warehouse/create", createWarehouse);

router.post("/shipment/create", createShipmentForOrder);
router.post("/create-shipment", createShipmentForOrder);
router.post("/shipment/update", updateShipmentDetails);

router.post("/tracking", trackShipmentStatus);
router.post("/label", generateLabel);
router.post("/pickup", createPickupRequest);
router.post("/ndr", updateNdrAction);

export default router;
