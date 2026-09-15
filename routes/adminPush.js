/**
 * routes/adminPush.js
 * Authenticated admin Web Push subscription management.
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireActiveAdmin } from "../middleware/requireActiveAdmin.js";
import {
  getPublicVapidKey,
  getPushStatus,
  sendTestPush,
  subscribePush,
  unsubscribePush,
} from "../controllers/adminPushController.js";

const router = Router();

router.use(requireAuth, requireActiveAdmin);

router.get("/vapid-public-key", getPublicVapidKey);
router.get("/status", getPushStatus);
router.post("/subscribe", subscribePush);
router.post("/unsubscribe", unsubscribePush);
router.delete("/subscribe", unsubscribePush);
router.post("/test", sendTestPush);

export default router;
