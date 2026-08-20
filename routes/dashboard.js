/**
 * routes/dashboard.js
 */

import { Router } from "express";
import { getStats } from "../controllers/dashboardController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/stats", requireAuth, getStats);

export default router;
