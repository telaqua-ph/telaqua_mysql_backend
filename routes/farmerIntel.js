import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireActiveAdmin } from "../middleware/requireActiveAdmin.js";
import { farmerIntelAccess } from "../middleware/adminPermissions.js";
import { farmerIntelLogin } from "../controllers/farmerIntelAuthController.js";
import { correctShipmentCourier, getMapBasemap, getMapSummary, getPincodeOrders, listMissingCouriers } from "../controllers/farmerIntelController.js";

const router = Router();
// Normal admin login only. The separate Farmer Intel login is off unless FARMER_INTEL_LOGIN_REQUIRED=true.
router.use(requireAuth, requireActiveAdmin);
router.post("/login", farmerIntelLogin);
router.use(farmerIntelAccess());
router.get("/basemap", getMapBasemap);
router.get("/summary", getMapSummary);
router.get("/pincodes/:pincode/orders", getPincodeOrders);
router.get("/couriers/missing", listMissingCouriers);
router.patch("/shipments/:shipmentId/courier", correctShipmentCourier);
export default router;
