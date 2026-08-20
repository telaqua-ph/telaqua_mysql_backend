/**
 * routes/delivery.js
 *
 * Delhivery B2C — shipment creation only (CMU create.json).
 * Pickup, labels, and Ready for Pickup are handled in Delhivery One — not here.
 * See docs/DELHIVERY_FLOW.md
 */

import { Router } from "express";
import { createShipmentForOrder } from "../controllers/deliveryController.js";

const router = Router();

router.post("/shipment/create", createShipmentForOrder);
router.post("/create-shipment", createShipmentForOrder);

export default router;
