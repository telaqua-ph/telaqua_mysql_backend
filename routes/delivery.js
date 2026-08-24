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
  calculateRate,
  checkServiceability,
  checkTat,
  compatibilityNdr,
  compatibilityPickup,
  compatibilityTrackShipment,
  compatibilityUpdateShipment,
  createOrderShipment,
  createWarehouse,
  generateWaybill,
} from "../controllers/logisticsController.js";

const router = Router();

router.use(requireAuth);

router.get("/serviceability/:pincode", checkServiceability);
router.get("/tat", checkTat);
router.get("/waybill", (req, res) => {
  req.body = { ...(req.body || {}), order_id: req.query.order_id || req.query.orderId };
  return generateWaybill(req, res);
});
router.get("/rate", calculateRate);
router.post("/warehouse/create", createWarehouse);

router.post("/shipment/create", createOrderShipment);
router.post("/create-shipment", createOrderShipment);
router.post("/shipment/update", compatibilityUpdateShipment);

router.post("/tracking", compatibilityTrackShipment);
router.post("/pickup", compatibilityPickup);
router.post("/ndr", compatibilityNdr);

export default router;
