/**
 * routes/promoCodes.js
 *
 * Admin promo code management — all routes require JWT (requireAuth).
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  createPromoCodeHandler,
  listPromoCodesHandler,
  getPromoCodeHandler,
  updatePromoCodeHandler,
  updatePromoCodeStatusHandler,
} from "../controllers/promoCodesController.js";

const router = Router();

router.post("/", requireAuth, createPromoCodeHandler);
router.get("/", requireAuth, listPromoCodesHandler);
router.patch("/:id/status", requireAuth, updatePromoCodeStatusHandler);
router.get("/:id", requireAuth, getPromoCodeHandler);
router.put("/:id", requireAuth, updatePromoCodeHandler);

export default router;
