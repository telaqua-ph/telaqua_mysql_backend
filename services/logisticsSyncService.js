import { query } from "../config/db.js";
import { refreshOneShipment } from "../controllers/logisticsController.js";

let timer = null;
let running = false;

async function runTrackingSync() {
  if (running) return;
  running = true;
  try {
    const { rows } = await query(
      `SELECT * FROM shipments
       WHERE waybill_number IS NOT NULL
         AND fulfillment_status NOT IN ('delivered','cancelled','returned')
         AND (last_tracking_update IS NULL OR last_tracking_update < DATE_SUB(NOW(), INTERVAL 30 MINUTE))
       ORDER BY COALESCE(last_tracking_update, created_at) ASC LIMIT 25`
    );
    for (const shipment of rows) {
      try { await refreshOneShipment(shipment, null); }
      catch (error) { console.error("Scheduled Delhivery tracking failed", { shipmentId: shipment.id, message: error?.message }); }
    }
  } catch (error) {
    console.error("Scheduled Delhivery tracking sync failed", { code: error?.code, message: error?.message });
  } finally {
    running = false;
  }
}

export function startLogisticsTrackingSync() {
  if (String(process.env.DELHIVERY_TRACKING_SYNC_ENABLED || "").toLowerCase() !== "true") return null;
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
