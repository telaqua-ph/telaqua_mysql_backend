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
import revenueRoutes from "./routes/revenue.js";
import deliveryRoutes from "./routes/delivery.js";
import delhiveryWebhookRoutes from "./routes/delhiveryWebhook.js";
import logisticsRoutes from "./routes/logisticsRoutes.js";
import promoRoutes from "./routes/promo.js";
import promoCodesRoutes from "./routes/promoCodes.js";
import inventoryRoutes from "./routes/inventory.js";
import adminPushRoutes from "./routes/adminPush.js";
import invoiceLinkRoutes from "./routes/invoiceLink.js";
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
app.use(
  "/api/delhivery/webhook",
  express.raw({ type: "*/*", limit: "256kb" }),
  delhiveryWebhookRoutes
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
// Home page: browsers (e.g. DLT/SMS reviewers opening the domain) get a readable business page;
// API clients and uptime checks that ask for JSON still get the JSON status.
const HOME_PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tel-Aqua by AQUA AI PRIVATE LIMITED</title></head>
<body style="font-family:Arial,sans-serif;margin:0;color:#14213D;background:#F5F8FB">
<div style="background:#063970;color:#fff;padding:32px 20px;text-align:center">
<h1 style="margin:0;font-size:26px">Tel-Aqua</h1>
<p style="margin:8px 0 0">AQUA AI PRIVATE LIMITED &middot; Water-quality instruments</p></div>
<div style="max-width:560px;margin:32px auto;padding:0 20px;line-height:1.6">
<p>This is the official order and invoice service of Tel-Aqua (AQUA AI PRIVATE LIMITED).</p>
<p>Customers receive a secure link to download the invoice for their own order after it is placed on our website.</p>
<p><a href="https://telaqua.in" style="display:inline-block;background:#063970;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Visit telaqua.in</a></p>
</div></body></html>`;

app.get("/", (req, res) => {
  if (req.accepts(["json", "html"]) === "html") {
    return res.status(200).type("html").send(HOME_PAGE_HTML);
  }
  return res.status(200).json({
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
app.use("/api/revenue", revenueRoutes);
app.use("/api/delivery", deliveryRoutes);
app.use("/api/delhivery", deliveryRoutes);
app.use("/api/admin/logistics", logisticsRoutes);
app.use("/api/admin/push", adminPushRoutes);

// Public WhatsApp invoice link (MyOperator template button: /i/{{1}})
app.use("/i", invoiceLinkRoutes);

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
