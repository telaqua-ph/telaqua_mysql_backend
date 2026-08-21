import "dotenv/config";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "../config/db.js";
import { getDelhiveryEnvironment } from "../config/delhiveryConfig.js";

const sqlPath = fileURLToPath(new URL("../sql/add_delhivery_logistics.sql", import.meta.url));
const source = await fs.readFile(sqlPath, "utf8");
const statements = source
  .split(/;\s*(?:\r?\n|$)/)
  .map((value) => value.replace(/^\s*--.*$/gm, "").trim())
  .filter(Boolean);

const client = await pool.connect();
try {
  for (const statement of statements) {
    try {
      await client.query(statement);
    } catch (error) {
      if (!["ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"].includes(error?.code)) throw error;
    }
  }
  const environment = getDelhiveryEnvironment();
  await client.query(
    `UPDATE orders SET fulfillment_status = CASE
       WHEN LOWER(COALESCE(tracking_status,'')) LIKE '%delivered%' THEN 'delivered'
       WHEN LOWER(COALESCE(tracking_status,'')) LIKE '%out for delivery%' THEN 'out_for_delivery'
       WHEN LOWER(COALESCE(tracking_status,'')) LIKE '%transit%' THEN 'in_transit'
       WHEN LOWER(COALESCE(shipment_status,'')) LIKE '%ndr%' THEN 'ndr'
       WHEN pickup_requested_at IS NOT NULL THEN 'pickup_requested'
       WHEN shipment_created_at IS NOT NULL THEN 'shipment_created'
       WHEN waybill IS NOT NULL AND waybill <> '' THEN 'ready_to_ship'
       ELSE fulfillment_status END`
  );
  await client.query(
    `INSERT IGNORE INTO shipments (
       order_id, sequence_no, idempotency_key, environment, shipment_id,
       waybill_number, fulfillment_status, shipment_status, shipment_created_at,
       pickup_requested_at, shipping_label_url, last_tracking_update, last_error
     )
     SELECT id, 1, CONCAT('order:', id, ':shipment:1'), ?, delhivery_shipment_id,
       NULLIF(waybill,''), fulfillment_status, shipment_status, shipment_created_at,
       pickup_requested_at, label_data, tracking_updated_at, shipment_error
     FROM orders
     WHERE NULLIF(waybill,'') IS NOT NULL OR shipment_created_at IS NOT NULL OR delhivery_shipment_id IS NOT NULL`,
    [environment]
  );
  console.log(`Delhivery logistics migration complete (${statements.length} statements).`);
} finally {
  client.release();
  await pool.end();
}
