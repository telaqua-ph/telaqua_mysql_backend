import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireActiveAdmin } from "../middleware/requireActiveAdmin.js";
import { requireFarmerIntelLogin } from "../middleware/adminPermissions.js";
import { farmerIntelLogin } from "../controllers/farmerIntelAuthController.js";
import { correctShipmentCourier, getMapBasemap, getMapSummary, getPincodeOrders, listMissingCouriers } from "../controllers/farmerIntelController.js";

const router = Router();
// Step 1: normal admin login. Step 2: separate Farmer Intel email + password.
router.use(requireAuth, requireActiveAdmin);
router.post("/login", farmerIntelLogin);
router.use(requireFarmerIntelLogin());
router.get("/basemap", getMapBasemap);
router.get("/summary", getMapSummary);
router.get("/pincodes/:pincode/orders", getPincodeOrders);
router.get("/couriers/missing", listMissingCouriers);
router.patch("/shipments/:shipmentId/courier", correctShipmentCourier);
export default router;
