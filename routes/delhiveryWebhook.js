import { Router } from "express";

import { pool } from "../config/db.js";
import { createDelhiveryWebhookHandler } from "../controllers/delhiveryWebhookController.js";

const router = Router();

router.post("/", createDelhiveryWebhookHandler(pool));

export default router;
