import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireActiveAdmin } from "../middleware/requireActiveAdmin.js";
import { requireFarmerIntelAccess } from "../middleware/adminPermissions.js";
import { correctShipmentCourier, getMapBasemap, getMapSummary, getPincodeOrders, listMissingCouriers } from "../controllers/farmerIntelController.js";

const router = Router();
router.use(requireAuth, requireActiveAdmin, requireFarmerIntelAccess());
router.get("/basemap", getMapBasemap);
router.get("/summary", getMapSummary);
router.get("/pincodes/:pincode/orders", getPincodeOrders);
router.get("/couriers/missing", listMissingCouriers);
router.patch("/shipments/:shipmentId/courier", correctShipmentCourier);
export default router;
