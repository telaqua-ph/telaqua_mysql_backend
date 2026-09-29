/**
 * controllers/orderDeliveryDetailsController.js
 *
 * PATCH /api/orders/:id/delivery-details          — admin corrects shipping details
 * GET   /api/orders/:id/delivery-details/history  — audit trail for that order
 *
 * Decision logic lives in services/orderDeliveryDetails.js.
 */

import { pool, query } from "../config/db.js";
import { updateShipment } from "../services/delhiveryService.js";
import {
  DELIVERY_DETAIL_FIELDS,
  classifyShipmentStage,
  pickDeliveryDetails,
  saveOrderDeliveryDetails,
} from "../services/orderDeliveryDetails.js";
import {
  acquireShipmentOperation,
  assertDelhiveryAccepted,
  refreshOneShipment,
  releaseShipmentOperation,
} from "./logisticsController.js";

const asJson = (value) => (value == null ? null : JSON.stringify(value));

function parseOrderId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

let auditTableReady;

export function ensureDeliveryAuditTable() {
  if (!auditTableReady) {
    auditTableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS order_delivery_audit_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        order_id BIGINT UNSIGNED NOT NULL,
        shipment_id BIGINT UNSIGNED NULL,
        admin_id INT NULL,
        admin_email VARCHAR(255) NULL,
        action VARCHAR(40) NOT NULL,
        shipment_stage VARCHAR(40) NULL,
        waybill VARCHAR(40) NULL,
        changed_fields JSON NULL,
        before_data JSON NULL,
        after_data JSON NULL,
        courier_status VARCHAR(20) NOT NULL,
        courier_message VARCHAR(1000) NULL,
        courier_request JSON NULL,
        courier_response JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_order_delivery_audit_order (order_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch((error) => {
      auditTableReady = null;
      throw error;
    });
  }
  return auditTableReady;
}

async function loadShipment(orderId, client = { query }, lock = false) {
  try {
    const { rows } = await client.query(
      `SELECT * FROM shipments WHERE order_id = ? AND sequence_no = 1 LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [orderId]
    );
    return rows[0] || null;
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") return null;
    throw error;
  }
}

async function loadOrder(orderId, client = { query }, lock = false) {
  const { rows } = await client.query(
    `SELECT * FROM orders WHERE id = ? LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [orderId]
  );
  return rows[0] || null;
}

async function latestAudit(orderId) {
  await ensureDeliveryAuditTable();
  const { rows } = await query(
    `SELECT id, courier_status, created_at FROM order_delivery_audit_log
     WHERE order_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [orderId]
  );
  return rows[0] || null;
}

function conflict(message) {
  return Object.assign(new Error(message), { httpStatus: 409, publicMessage: message });
}

/**
 * Update only this order's delivery columns and write the audit row, in one
 * transaction. Re-checks the shipment stage under row locks so a shipment
 * created (or picked up) concurrently cannot be left with stale details.
 */
async function persist({ order, data, changes, classification, courier, admin, action, shipment }) {
  await ensureDeliveryAuditTable();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockedOrder = await loadOrder(order.id, client, true);
    if (!lockedOrder) throw conflict("Order no longer exists.");
    const lockedShipment = await loadShipment(order.id, client, true);
    const current = classifyShipmentStage(lockedOrder, lockedShipment);
    // When Delhivery was already updated the order must be saved to match it;
    // only a shipment created/advanced after a DB-only decision is a conflict.
    if (classification.stage === "not_created" && current.stage !== "not_created") {
      throw conflict("A Delhivery shipment was created for this order while saving. Reload the order and try again.");
    }
    if (
      current.stage === "not_created" &&
      lockedShipment?.processing_token &&
      lockedShipment?.processing_started_at &&
      Date.now() - new Date(lockedShipment.processing_started_at).getTime() < 10 * 60 * 1000
    ) {
      throw conflict("A Delhivery shipment is being created for this order right now. Try again in a minute.");
    }

    if (changes.length) {
      const assignments = DELIVERY_DETAIL_FIELDS.map((field) => `${field} = ?`).join(", ");
      await client.query(
        `UPDATE orders SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [...DELIVERY_DETAIL_FIELDS.map((field) => data[field]), order.id]
      );
    }

    await client.query(
      `INSERT INTO order_delivery_audit_log (
         order_id, shipment_id, admin_id, admin_email, action, shipment_stage, waybill,
         changed_fields, before_data, after_data, courier_status, courier_message,
         courier_request, courier_response
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.id,
        lockedShipment?.id || shipment?.id || null,
        admin?.id || null,
        admin?.email || null,
        action,
        classification.stage,
        classification.waybill || null,
        asJson(changes.map((change) => change.field)),
        asJson(pickDeliveryDetails(lockedOrder)),
        asJson(changes.length ? data : pickDeliveryDetails(lockedOrder)),
        courier.status,
        courier.message ? String(courier.message).slice(0, 1000) : null,
        asJson(courier.payload || null),
        asJson(courier.response || null),
      ]
    );

    if (lockedShipment?.id && courier.status !== "not_required") {
      await client.query(
        "INSERT INTO shipment_audit_log (shipment_id, admin_id, action, before_data, after_data) VALUES (?, ?, ?, ?, ?)",
        [
          lockedShipment.id,
          admin?.id || null,
          courier.status === "updated" ? "delivery_details_updated" : "delivery_details_update_failed",
          asJson(pickDeliveryDetails(lockedOrder)),
          asJson({ request: courier.payload || null, courier_status: courier.status, message: courier.message }),
        ]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function pushToCourier(payload) {
  const data = await updateShipment(payload);
  assertDelhiveryAccepted(data, "shipment_update");
  return data;
}

async function lockShipment(shipment) {
  const { token } = await acquireShipmentOperation(shipment.id, "delivery_details");
  return token;
}

async function releaseShipment({ shipment, token, courier }) {
  if (!shipment?.id) return;
  if (courier?.status === "updated") {
    await query(
      "UPDATE shipments SET shipment_update_response=?, shipment_updated_at=NOW(), last_error=NULL WHERE id=?",
      [asJson(courier.response || null), shipment.id]
    ).catch(() => {});
  } else if (courier?.status === "failed") {
    await query(
      "UPDATE shipments SET last_error=?, last_error_response=?, last_error_at=NOW() WHERE id=?",
      [
        `Delivery details update not applied at Delhivery: ${courier.message}`.slice(0, 2000),
        asJson(courier.response || null),
        shipment.id,
      ]
    ).catch(() => {});
  }
  await releaseShipmentOperation(shipment.id, token);
}

export const deliveryDetailsDeps = {
  loadOrder: (orderId) => loadOrder(orderId),
  loadShipment: (orderId) => loadShipment(orderId),
  refreshTracking: (shipment) => refreshOneShipment(shipment, null),
  latestAudit,
  lockShipment,
  pushToCourier,
  releaseShipment,
  persist,
};

function safeOrder(order) {
  if (!order) return order;
  const {
    invoice_access_token_hash: _hash,
    invoice_attempt_token: _attempt,
    ...rest
  } = order;
  return rest;
}

/** PATCH /api/orders/:id/delivery-details */
export async function updateOrderDeliveryDetails(req, res) {
  const orderId = parseOrderId(req.params.id);
  if (!orderId) return res.status(400).json({ success: false, message: "Invalid order id" });

  try {
    const result = await saveOrderDeliveryDetails(
      {
        orderId,
        body: req.body,
        admin: {
          id: req.admin?.id ?? (Number(req.user?.admin_id ?? req.user?.id) || null),
          email: req.admin?.email || req.user?.email || null,
        },
      },
      deliveryDetailsDeps
    );
    if (result.body?.order) result.body.order = safeOrder(result.body.order);
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Delivery details update failed:", {
      orderId,
      code: error?.code,
      message: error?.message,
    });
    if (error?.httpStatus) {
      return res.status(error.httpStatus).json({ success: false, message: error.publicMessage || error.message });
    }
    return res.status(500).json({ success: false, message: "Unable to update delivery details." });
  }
}

function parseJsonColumn(value) {
  if (value == null || typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** GET /api/orders/:id/delivery-details/history */
export async function getOrderDeliveryDetailsHistory(req, res) {
  const orderId = parseOrderId(req.params.id);
  if (!orderId) return res.status(400).json({ success: false, message: "Invalid order id" });
  try {
    await ensureDeliveryAuditTable();
    const { rows } = await query(
      `SELECT l.id, l.order_id, l.admin_id, l.admin_email, a.email AS current_admin_email,
              a.full_name AS admin_name, l.action, l.shipment_stage, l.waybill, l.changed_fields, l.before_data, l.after_data,
              l.courier_status, l.courier_message, l.created_at
       FROM order_delivery_audit_log l
       LEFT JOIN admins a ON a.id = l.admin_id
       WHERE l.order_id = ?
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT 20`,
      [orderId]
    );
    const history = rows.map(({ current_admin_email: currentEmail, ...row }) => ({
      ...row,
      admin_email: row.admin_email || currentEmail || null,
      changed_fields: parseJsonColumn(row.changed_fields) || [],
      before_data: parseJsonColumn(row.before_data),
      after_data: parseJsonColumn(row.after_data),
    }));
    return res.json({
      success: true,
      history,
      courier_sync_pending: history[0]?.courier_status === "failed",
    });
  } catch (error) {
    console.error("Delivery details history failed:", { orderId, code: error?.code });
    return res.status(500).json({ success: false, message: "Unable to load delivery details history." });
  }
}
