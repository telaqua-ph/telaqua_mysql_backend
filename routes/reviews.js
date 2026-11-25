import { Router } from "express";
import { createReview, getEligibleReviewOrders, getPublicPhMeterReviews, getPublicReviewPhoto } from "../controllers/reviewController.js";
import { requireCustomerAuth } from "../middleware/customerAuth.js";

const router = Router();
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
router.get("/ph-meter", asyncRoute(getPublicPhMeterReviews));
router.get("/:id/photo", asyncRoute(getPublicReviewPhoto));
router.get("/eligible-orders", requireCustomerAuth, asyncRoute(getEligibleReviewOrders));
router.post("/", requireCustomerAuth, asyncRoute(createReview));
export default router;
