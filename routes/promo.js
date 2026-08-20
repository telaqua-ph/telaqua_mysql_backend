/**
 * routes/promo.js
 *
 * Promo offer + validate endpoints.
 */

import { Router } from "express";
import {
  getPromoOffer,
  validatePromoCode,
} from "../controllers/promoController.js";

const router = Router();

router.get("/offer", getPromoOffer);
router.post("/validate", validatePromoCode);

export default router;
