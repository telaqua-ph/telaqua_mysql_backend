/**
 * app.js
 *
 * Express application setup — middleware + API routes.
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import authRoutes from "./routes/auth.js";
import ordersRoutes from "./routes/orders.js";
import paymentRoutes from "./routes/payment.js";
import testRazorpayRoutes from "./routes/testRazorpay.js";
import contactRoutes from "./routes/contact.js";
import customersRoutes from "./routes/customers.js";
import customerAccountRoutes from "./routes/customerAccount.js";
import dashboardRoutes from "./routes/dashboard.js";
import deliveryRoutes from "./routes/delivery.js";
import promoRoutes from "./routes/promo.js";
import promoCodesRoutes from "./routes/promoCodes.js";
import inventoryRoutes from "./routes/inventory.js";
import { handleSwipeWebhook } from "./controllers/swipeWebhookController.js";
import { handleRazorpayWebhook } from "./controllers/razorpayWebhookController.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVOICES_STATIC_DIR =
  process.env.INVOICES_STORAGE_DIR?.trim() ||
  path.join(__dirname, "public", "invoices");

const app = express();
app.set("trust proxy", 1);

function buildCorsOrigin() {
  const frontendUrl = (process.env.FRONTEND_URL || "").trim();
  const corsOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowlist = new Set(
    [
      ...corsOrigins,
      frontendUrl,
      // Local development only
      "http://localhost:5173",
      "http://localhost:3000",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:3000",
    ].filter(Boolean)
  );

  // If no production origins configured, reflect request origin (dev-friendly)
  if (!frontendUrl && corsOrigins.length === 0) {
    return true;
  }

  return (origin, callback) => {
    // Non-browser clients (Postman, server-to-server) often send no Origin
    if (!origin) {
      return callback(null, true);
    }
    if (allowlist.has(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  };
}

app.use(helmet());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(
  cors({
    origin: buildCorsOrigin(),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-CSRF-Token",
      "X-Requested-With",
      "Accept",
      "Accept-Version",
      "Content-Length",
      "Content-MD5",
      "Date",
      "X-Api-Version",
      "X-Order-Token",
    ],
  })
);
app.post(
  "/api/webhooks/razorpay",
  express.raw({ type: "application/json", limit: "1mb" }),
  handleRazorpayWebhook
);
app.post(
  "/api/webhooks/swipe",
  express.raw({ type: "application/json", limit: "1mb" }),
  handleSwipeWebhook
);
app.use(express.json({ limit: "1mb" }));

// Public invoice PDFs (Interakt document header must fetch via HTTPS)
app.use(
  "/invoices",
  express.static(INVOICES_STATIC_DIR, {
    index: false,
    dotfiles: "deny",
    setHeaders(res) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "public, max-age=86400");
    },
  })
);

// Health checks — must not depend on DB, Razorpay, or Delhivery
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Tel-Aqua API is running",
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Tel-Aqua API is healthy",
  });
});

// Same URL paths as the previous Vercel serverless API
app.use("/api/auth", authRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/payment", paymentRoutes);
/** Isolated ₹1 LIVE test aliases — same handlers as create-test-order / verify-payment */
app.use("/api/test/razorpay", testRazorpayRoutes);
app.use("/api/promo", promoRoutes);
app.use("/api/promo-codes", promoCodesRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/customer", customerAccountRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/delivery", deliveryRoutes);
app.use("/api/delhivery", deliveryRoutes);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Not found",
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", {
    message: err?.message,
    code: err?.code,
    path: req?.path,
  });

  if (err?.code === "DB_CONFIG_ERROR") {
    return res.status(503).json({
      success: false,
      message: "Database is not configured",
    });
  }

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

export default app;
