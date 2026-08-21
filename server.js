/**
 * server.js
 *
 * Entry point — loads env and starts the Express server.
 * Hostinger requires listening on 0.0.0.0 and process.env.PORT.
 */

import "dotenv/config";
import app from "./app.js";
import { isDatabaseConfigured } from "./config/db.js";
import { startLogisticsTrackingSync, stopLogisticsTrackingSync } from "./services/logisticsSyncService.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

function logSafeStartupInfo() {
  console.log("Startup:", {
    node: process.version,
    env: process.env.NODE_ENV || "development",
    host: HOST,
    port: PORT,
    databaseConfigured: isDatabaseConfigured(),
    jwtConfigured: Boolean(process.env.JWT_SECRET),
    razorpayConfigured: Boolean(
      process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
    ),
    delhiveryConfigured: Boolean(process.env.DELHIVERY_API_TOKEN),
    delhiveryEnv: process.env.DELHIVERY_ENV || "(not set)",
  });
}

let server;

try {
  logSafeStartupInfo();

  server = app.listen(PORT, HOST, () => {
    console.log(`Tel-Aqua API running on http://${HOST}:${PORT}`);
    startLogisticsTrackingSync();
  });

  server.on("error", (err) => {
    console.error("HTTP server error:", {
      code: err?.code,
      message: err?.message,
    });
    process.exit(1);
  });
} catch (err) {
  console.error("Failed to start Tel-Aqua API:", {
    message: err?.message,
    name: err?.name,
  });
  process.exit(1);
}

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  stopLogisticsTrackingSync();
  if (!server) {
    process.exit(0);
    return;
  }

  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", {
    message: err?.message,
    name: err?.name,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", {
    message: reason?.message || String(reason),
  });
});
