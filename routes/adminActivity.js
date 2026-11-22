import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireActiveAdmin } from "../middleware/requireActiveAdmin.js";
import {
  getActivityAccess,
  getActivityFilters,
  getActivityLog,
  getOrderActivity,
  requireActivityLogViewer,
} from "../controllers/adminActivityController.js";

// Read-only: there are deliberately no POST / PUT / DELETE routes here.
const router = Router();
router.use(requireAuth, requireActiveAdmin);
router.get("/access", getActivityAccess);
router.use(requireActivityLogViewer);
router.get("/", getActivityLog);
router.get("/filters", getActivityFilters);
router.get("/orders/:orderId", getOrderActivity);
export default router;
