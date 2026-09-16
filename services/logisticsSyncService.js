import { query } from "../config/db.js";
import { refreshOneShipment } from "../controllers/logisticsController.js";
import { getDelhiveryEnvironment } from "../config/delhiveryConfig.js";
import {
  isDelhiveryThrottledError,
  isDelhiveryWaybillMissingError,
  parseThrottleWaitMs,
} from "./delhiveryService.js";

let timer = null;
let running = false;

const DEFAULT_PACE_MS = 750;
const MAX_SYNC_BATCH = 25;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paceMs() {
  const n = Number(process.env.DELHIVERY_TRACKING_PACE_MS);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PACE_MS;
  return Math.min(Math.floor(n), 10_000);
}

async function runTrackingSync() {
  if (running) return;
  running = true;
  try {
    const { rows } = await query(
      `SELECT * FROM shipments
       WHERE waybill_number IS NOT NULL
         AND environment = ?
         AND fulfillment_status COLLATE utf8mb4_unicode_ci NOT IN (
           'delivered' COLLATE utf8mb4_unicode_ci,
           'cancelled' COLLATE utf8mb4_unicode_ci,
           'returned' COLLATE utf8mb4_unicode_ci
         )
         AND (last_tracking_update IS NULL OR last_tracking_update < DATE_SUB(NOW(), INTERVAL 30 MINUTE))
       ORDER BY COALESCE(last_tracking_update, created_at) ASC LIMIT ${MAX_SYNC_BATCH}`,
      [getDelhiveryEnvironment()]
    );

    const delay = paceMs();
    for (let i = 0; i < rows.length; i += 1) {
      const shipment = rows[i];
      try {
        await refreshOneShipment(shipment, null);
      } catch (error) {
        if (isDelhiveryWaybillMissingError(error)) {
          await query(
            "UPDATE shipments SET last_error=?, last_tracking_update=NOW() WHERE id=?",
            [
              String(error?.message || "Delhivery has no data for this waybill").slice(0, 2000),
              shipment.id,
            ]
          ).catch(() => {});
          console.warn("Scheduled Delhivery tracking: waybill not found upstream", {
            shipmentId: shipment.id,
          });
        } else if (isDelhiveryThrottledError(error)) {
          const waitMs = error.retryAfterMs || parseThrottleWaitMs(error.message);
          console.warn("Scheduled Delhivery tracking throttled; pausing batch", {
            shipmentId: shipment.id,
            waitMs,
          });
          await query("UPDATE shipments SET last_error=? WHERE id=?", [
            String(error?.message || "Throttled").slice(0, 2000),
            shipment.id,
          ]).catch(() => {});
          await sleep(waitMs);
        } else {
          await query("UPDATE shipments SET last_error=? WHERE id=?", [
            String(error?.message || "Scheduled tracking failed").slice(0, 2000),
            shipment.id,
          ]).catch(() => {});
          console.error("Scheduled Delhivery tracking failed", {
            shipmentId: shipment.id,
            message: error?.message,
            code: error?.code,
            stage: error?.queryStage || null,
          });
        }
      }

      if (i < rows.length - 1 && delay > 0) {
        await sleep(delay);
      }
    }
    if (rows.length) {
      console.log("Scheduled Delhivery tracking processed", {
        attempted: rows.length,
      });
    }
  } catch (error) {
    console.error("Scheduled Delhivery tracking sync failed", {
      code: error?.code,
      message: error?.message,
    });
  } finally {
    running = false;
  }
}

export { runTrackingSync };

export function startLogisticsTrackingSync() {
  if (String(process.env.DELHIVERY_TRACKING_SYNC_ENABLED || "").toLowerCase() !== "true") {
    return null;
  }
  const minutes = Math.max(15, Number(process.env.DELHIVERY_TRACKING_SYNC_MINUTES) || 30);
  timer = setInterval(runTrackingSync, minutes * 60 * 1000);
  timer.unref();
  setTimeout(runTrackingSync, 10_000).unref();
  return timer;
}

export function stopLogisticsTrackingSync() {
  if (timer) clearInterval(timer);
  timer = null;
}
