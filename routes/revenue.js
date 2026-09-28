import { Router } from "express";
import { getRevenueReport } from "../controllers/revenueController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.get("/", requireAuth, getRevenueReport);

export default router;
