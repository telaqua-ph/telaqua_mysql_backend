import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  calculateRate,
  checkServiceability,
  checkTat,
  createOrderShipment,
  createWarehouse,
  generateWaybill,
  getNdr,
  getOrderLogistics,
  getShipment,
  getShipmentTracking,
  getWarehouse,
  pickupShipment,
  refreshActiveTracking,
  refreshTracking,
  shipmentLabel,
  submitNdr,
  updateShipmentDetails,
} from "../controllers/logisticsController.js";

const router = Router();
router.use(requireAuth);

router.get("/serviceability/:pincode", checkServiceability);
router.post("/tat", checkTat);
router.post("/rate", calculateRate);
router.post("/waybill", generateWaybill);
router.get("/warehouse", getWarehouse);
router.post("/warehouse", createWarehouse);
router.get("/orders/:orderId", getOrderLogistics);
router.post("/orders/:orderId/shipment", createOrderShipment);
router.get("/shipments/:shipmentId", getShipment);
router.get("/shipments/:shipmentId/label", shipmentLabel);
router.post("/shipments/:shipmentId/pickup", pickupShipment);
router.post("/shipments/track-active", refreshActiveTracking);
router.post("/shipments/:shipmentId/track", refreshTracking);
router.put("/shipments/:shipmentId", updateShipmentDetails);
router.get("/shipments/:shipmentId/tracking", getShipmentTracking);
router.get("/shipments/:shipmentId/ndr", getNdr);
router.post("/shipments/:shipmentId/ndr", submitNdr);

export default router;
