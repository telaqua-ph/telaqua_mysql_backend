/**
 * Inventory + admin notification routes.
 * Mutations require admin JWT; public stock check is read-only.
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  getHistory,
  getInventory,
  getNotifications,
  getPublicStock,
  patchNotificationRead,
  patchNotificationsReadAll,
  patchThreshold,
  postAddStock,
  postAdjustStock,
} from "../controllers/inventoryController.js";

const router = Router();

router.get("/stock", getPublicStock);

router.use(requireAuth);

router.get("/", getInventory);
router.get("/history", getHistory);
router.post("/add-stock", postAddStock);
router.post("/adjust", postAdjustStock);
router.patch("/:sku/threshold", patchThreshold);

router.get("/notifications/list", getNotifications);
router.patch("/notifications/read-all", patchNotificationsReadAll);
router.patch("/notifications/:id/read", patchNotificationRead);

export default router;
