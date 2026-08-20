/**
 * routes/customers.js
 */

import { Router } from "express";
import {
  listCustomers,
  getCustomerById,
} from "../controllers/customerController.js";

const router = Router();

router.get("/", listCustomers);
router.get("/:id", getCustomerById);

export default router;
