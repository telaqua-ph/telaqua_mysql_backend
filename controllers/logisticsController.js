import crypto from "node:crypto";
import { pool, query } from "../config/db.js";
import {
  getDelhiveryEnvironment,
  getDelhiveryReadiness,
  getSafeDelhiveryConfig,
  getTelaquaProductDefaults,
  getTelaquaWarehouse,
} from "../config/delhiveryConfig.js";
import {
  checkPincodeServiceability,
  createClientWarehouse,
  createShipment,
  getExpectedTat,
  getShippingRate,
  getWaybills,
  requestPickup,
  trackShipment,
  updateNdr,
  updateShipment,
} from "../services/delhiveryService.js";
import {
  canAdvanceFulfillment,
  extractTrackingEvents,
  isTerminalFulfillmentStatus,
  mapDelhiveryStatus,
} from "../services/logisticsState.js";
import { isStatusEventCurrent } from "../services/delhiveryWebhookService.js";
import { canFulfillOrder } from "../services/paymentMode.js";

const asJson = (value) => (value == null ? null : JSON.stringify(value));
const clean = (value) => String(value ?? "").replace(/[&#%;\\]/g, " ").replace(/\s+/g, " ").trim();
const idOf = (value) => (/^\d+$/.test(String(value || "")) ? Number(value) : null);
const mysqlDateTime = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const text = String(value).replace("T", " ").replace(/Z$/, "").slice(0, 19);
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text : null;
  }
  return date.toISOString().slice(0, 19).replace("T", " ");
};
const mysqlDate = (value) => mysqlDateTime(value)?.slice(0, 10) || null;

function logicalFailureMessage(payload) {
  if (!payload || typeof payload !== "object") return null;
  const candidates = [payload.error, payload.errors, payload.message, payload.msg, payload.remark, payload.remarks, payload.rmk];
  const hasErrorValue = typeof payload.error === "string"
    ? Boolean(payload.error.trim())
    : Array.isArray(payload.error)
      ? payload.error.length > 0
      : Boolean(payload.error && (typeof payload.error !== "object" || Object.keys(payload.error).length));
  const failed = payload.success === false || payload.status === false || hasErrorValue;
  if (failed) {
    return candidates.flat().find((value) => typeof value === "string" && value.trim())?.trim() || "Delhivery rejected the request.";
  }
  const status = typeof payload.status === "string" ? payload.status : "";
  if (/fail|error|invalid|reject/i.test(status)) return status;
  const message = candidates.flat().find((value) => typeof value === "string" && value.trim());
  if (message && /fail|error|invalid|reject|unauthori[sz]ed|not allowed|not found/i.test(message)) return message.trim();
  const packages = Array.isArray(payload.packages) ? payload.packages : [];
  for (const pkg of packages) {
    const packageStatus = String(pkg?.status || "");
    if (/fail|error|invalid|reject/i.test(packageStatus) || pkg?.success === false) {
      return String(pkg?.remarks || pkg?.remark || pkg?.message || packageStatus || "Delhivery rejected the shipment.").trim();
    }
  }
  return null;
}

function assertDelhiveryAccepted(payload, operation) {
  const message = logicalFailureMessage(payload);
  if (!message) return;
  const error = new Error(message);
  error.code = "DELHIVERY_UPSTREAM_ERROR";
  error.status = 422;
  error.operation = operation;
  throw error;
}

function findResponseValue(payload, keys, depth = 0) {
  if (payload == null || depth > 5) return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findResponseValue(item, keys, depth + 1);
      if (found !== null && found !== undefined && found !== "") return found;
    }
    return null;
  }
  if (typeof payload !== "object") return null;
  for (const key of keys) {
    if (payload[key] !== null && payload[key] !== undefined && payload[key] !== "") return payload[key];
  }
  for (const value of Object.values(payload)) {
    if (value && typeof value === "object") {
      const found = findResponseValue(value, keys, depth + 1);
      if (found !== null && found !== undefined && found !== "") return found;
    }
  }
  return null;
}

function apiError(res, error, fallback = "Unable to complete logistics request") {
  console.error("Logistics error", { code: error?.code, status: error?.status, message: error?.message });
  if (error?.code === "DELHIVERY_CONFIG_ERROR") return res.status(503).json({ success: false, message: error.message });
  if (error?.code === "DELHIVERY_TIMEOUT") return res.status(504).json({ success: false, message: "Delhivery request timed out." });
  if (error?.code === "DELHIVERY_NETWORK_ERROR") return res.status(502).json({ success: false, message: "Delhivery is currently unavailable." });
  if (error?.code === "DELHIVERY_INVALID_RESPONSE") return res.status(502).json({ success: false, message: error.message || "Delhivery returned an invalid response." });
  if (error?.code === "DELHIVERY_UPSTREAM_ERROR") {
    const status = [400, 401, 403, 404, 409, 422, 429].includes(error.status) ? error.status : 502;
    return res.status(status).json({ success: false, message: error.message || fallback });
  }
  if (["ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR"].includes(error?.code)) {
    return res.status(503).json({ success: false, message: "Logistics database migration is required. Run npm run migrate:delhivery." });
  }
  return res.status(error?.httpStatus || 500).json({ success: false, message: error?.publicMessage || fallback });
}

async function orderById(orderId, client = { query }) {
  const { rows } = await client.query("SELECT * FROM orders WHERE id = ? LIMIT 1", [orderId]);
  return rows[0] || null;
}

async function shipmentById(shipmentId, client = { query }, lock = false) {
  const { rows } = await client.query(`SELECT * FROM shipments WHERE id = ? LIMIT 1${lock ? " FOR UPDATE" : ""}`, [shipmentId]);
  return rows[0] || null;
}

async function shipmentForOrder(orderId, client = { query }, lock = false) {
  const { rows } = await client.query(`SELECT * FROM shipments WHERE order_id = ? AND sequence_no = 1 LIMIT 1${lock ? " FOR UPDATE" : ""}`, [orderId]);
  return rows[0] || null;
}

async function ensureShipment(orderId, client = { query }) {
  let shipment = await shipmentForOrder(orderId, client, false);
  if (shipment) return shipment;
  const environment = getDelhiveryEnvironment();
  try {
    const inserted = await client.query(
      `INSERT INTO shipments (order_id, sequence_no, idempotency_key, environment, fulfillment_status)
       VALUES (?, 1, ?, ?, 'unfulfilled')`,
      [orderId, `order:${orderId}:shipment:1`, environment]
    );
    shipment = await shipmentById(inserted.insertId, client);
  } catch (error) {
    if (error?.code !== "ER_DUP_ENTRY") throw error;
    shipment = await shipmentForOrder(orderId, client);
  }
  return shipment;
}

function firstWaybill(payload) {
  const values = payload?.waybills || payload?.data || payload?.wbns || payload?.waybill || payload;
  const list = Array.isArray(values) ? values : String(values || "").split(",");
  return list.map((v) => String(v?.waybill || v?.wbn || v || "").trim()).find((v) => /^\d{8,20}$/.test(v)) || null;
}

function shipmentIdentity(payload) {
  const pkg = Array.isArray(payload?.packages) ? payload.packages[0] : null;
  return {
    waybill: firstWaybill(pkg || payload),
    shipmentId: String(pkg?.shipment_id || pkg?.refnum || payload?.shipment_id || payload?.reference || "").trim() || null,
    status: String(pkg?.status || payload?.status || payload?.message || "Shipment Created").trim(),
  };
}

function trackingSummary(payload) {
  const root = payload?.ShipmentData?.[0]?.Shipment || payload?.Shipment || payload || {};
  return {
    status: root.Status?.Status || root.Status || root.status || root.CurrentStatus || null,
    code: root.Status?.StatusCode || root.StatusCode || root.status_code || null,
    expectedDeliveryDate: root.ExpectedDeliveryDate || root.EDD || root.expected_delivery_date || null,
    statusDateTime: root.Status?.StatusDateTime || root.StatusDateTime || root.status_date_time || null,
    deliveredAt: root.DeliveredDate || null,
    ndrReason: root.Status?.Instructions || root.NDRReason || root.ndr_reason || null,
    location: root.Status?.StatusLocation || root.CurrentLocation || root.current_location || null,
  };
}

async function writeAudit(shipmentId, adminId, action, before, after, client = { query }) {
  await client.query(
    "INSERT INTO shipment_audit_log (shipment_id, admin_id, action, before_data, after_data) VALUES (?, ?, ?, ?, ?)",
    [shipmentId, adminId || null, action, asJson(before), asJson(after)]
  );
}

async function recordShipmentError(shipmentId, error) {
  if (!shipmentId) return;
  await query(
    "UPDATE shipments SET last_error=?, last_error_response=?, last_error_at=NOW() WHERE id=?",
    [String(error?.message || "Logistics operation failed").slice(0, 2000), asJson(error?.upstreamBody || null), shipmentId]
  ).catch(() => {});
}

function assertShipmentEnvironment(shipment) {
  const configured = getDelhiveryEnvironment();
  if (shipment?.environment && shipment.environment !== configured) {
    throw Object.assign(
      new Error(`This shipment belongs to the ${shipment.environment} Delhivery environment, while the backend is configured for ${configured}.`),
      { httpStatus: 409, publicMessage: `Shipment environment mismatch: ${shipment.environment} shipment cannot be processed in ${configured}.` }
    );
  }
}

async function acquireShipmentOperation(shipmentId, operation) {
  const token = `${operation}:${crypto.randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shipment = await shipmentById(shipmentId, client, true);
    if (!shipment) {
      await client.query("ROLLBACK");
      throw Object.assign(new Error("Shipment not found."), { httpStatus: 404, publicMessage: "Shipment not found." });
    }
    assertShipmentEnvironment(shipment);
    if (shipment.processing_token && shipment.processing_started_at && Date.now() - new Date(shipment.processing_started_at).getTime() < 10 * 60 * 1000) {
      await client.query("ROLLBACK");
      throw Object.assign(new Error("Another shipment operation is already in progress."), { httpStatus: 409, publicMessage: "Another shipment operation is already in progress." });
    }
    await client.query(
      "UPDATE shipments SET processing_token=?, processing_started_at=NOW(), last_error=NULL WHERE id=?",
      [token, shipment.id]
    );
    await client.query("COMMIT");
    return { shipment, token };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function releaseShipmentOperation(shipmentId, token) {
  if (!shipmentId || !token) return;
  await query(
    "UPDATE shipments SET processing_token=NULL, processing_started_at=NULL WHERE id=? AND processing_token=?",
    [shipmentId, token]
  ).catch(() => {});
}

function adminId(req) {
  return Number(req.user?.admin_id || req.user?.id) || null;
}

/**
 * Safety gate: reserving a real Delhivery waybill or creating a real
 * Delhivery shipment talks to the live courier (DELHIVERY_ENV=production
 * means a REAL AWB gets consumed immediately). Default is OFF so a paid
 * order simply stays "pending AWB" until this is deliberately turned on
 * by setting DELHIVERY_LIVE_FULFILLMENT_ENABLED=true as an environment
 * variable - a separate, explicit action from clicking buttons in the
 * admin app. This never touches existing orders/shipments data.
 */
function isLiveFulfillmentEnabled() {
  return String(process.env.DELHIVERY_LIVE_FULFILLMENT_ENABLED || "")
    .trim()
    .toLowerCase() === "true";
}

const LIVE_FULFILLMENT_PAUSED_MESSAGE =
  "Live Delhivery fulfillment is currently turned off, so this order stays pending AWB. " +
  "Set DELHIVERY_LIVE_FULFILLMENT_ENABLED=true when you're ready to reserve a real AWB.";

export async function getWarehouse(req, res) {
  try {
    const config = getSafeDelhiveryConfig();
    const readiness = getDelhiveryReadiness();
    let saved = null;
    try {
      const result = await query("SELECT * FROM logistics_warehouses WHERE is_default = 1 ORDER BY id DESC LIMIT 1");
      saved = result.rows[0] || null;
    } catch (error) {
      if (error?.code !== "ER_NO_SUCH_TABLE") throw error;
    }
    return res.json({ success: true, environment: config.environment, warehouse: saved || config.warehouse, configured: readiness.ready, readiness });
  } catch (error) { return apiError(res, error, "Unable to load warehouse"); }
}

export async function createWarehouse(req, res) {
  try {
    const warehouse = { ...getTelaquaWarehouse(), ...(req.body || {}) };
    if (!/^\d{6}$/.test(String(warehouse.pincode || warehouse.pin || ""))) return res.status(400).json({ success: false, message: "Warehouse pincode must be 6 digits." });
    const payload = {
      name: clean(warehouse.name), registered_name: clean(warehouse.registered_name || warehouse.name),
      address: clean(warehouse.address), city: clean(warehouse.city),
      pin: String(warehouse.pincode || warehouse.pin), phone: String(warehouse.phone),
      country: "India", return_address: clean(warehouse.address), return_pin: String(warehouse.pincode || warehouse.pin),
      return_city: clean(warehouse.city), return_state: clean(warehouse.state), return_country: "India",
    };
    const data = await createClientWarehouse(payload);
    assertDelhiveryAccepted(data, "warehouse_create");
    await query(
      `INSERT INTO logistics_warehouses (name, registered_name, address, city, state, pincode, phone, delhivery_reference, is_default, raw_response)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE address=VALUES(address), city=VALUES(city), state=VALUES(state), pincode=VALUES(pincode), phone=VALUES(phone), is_default=1, raw_response=VALUES(raw_response)`,
      [payload.name, payload.registered_name, payload.address, payload.city, warehouse.state, payload.pin, payload.phone, data?.warehouse_id || data?.name || null, asJson(data)]
    );
    return res.status(201).json({ success: true, message: "Warehouse created or verified.", data });
  } catch (error) { return apiError(res, error, "Unable to create warehouse"); }
}

export async function checkServiceability(req, res) {
  let shipment = null;
  try {
    const pincode = String(req.params.pincode || req.body?.pincode || "").trim();
    if (!/^\d{6}$/.test(pincode)) return res.status(400).json({ success: false, message: "Pincode must be 6 digits." });
    const orderId = idOf(req.query.order_id || req.body?.order_id);
    if (orderId) {
      if (!await orderById(orderId)) return res.status(404).json({ success: false, message: "Order not found." });
      shipment = await ensureShipment(orderId);
    }
    const data = await checkPincodeServiceability(pincode);
    assertDelhiveryAccepted(data, "serviceability");
    if (!Array.isArray(data?.delivery_codes)) {
      throw Object.assign(new Error("Delhivery returned an invalid serviceability response."), { code: "DELHIVERY_INVALID_RESPONSE" });
    }
    const centers = Array.isArray(data?.delivery_codes) ? data.delivery_codes : [];
    const serviceable = centers.length > 0 && !data?.error;
    const serviceabilityMessage = String(
      data?.message || data?.remark || centers[0]?.postal_code?.remarks ||
      (serviceable ? "Pincode is serviceable." : "Pincode is not serviceable.")
    ).slice(0, 500);
    if (shipment) {
      await query(
        "UPDATE shipments SET serviceable=?, serviceability_message=?, serviceability_checked_at=NOW(), serviceability_response=?, last_error=NULL WHERE id=?",
        [serviceable ? 1 : 0, serviceabilityMessage, asJson(data), shipment.id]
      );
    }
    return res.json({ success: true, serviceable, message: serviceabilityMessage, checked_at: new Date().toISOString(), data });
  } catch (error) { await recordShipmentError(shipment?.id, error); return apiError(res, error, "Unable to check serviceability"); }
}

export async function checkTat(req, res) {
  let shipment = null;
  try {
    const warehouse = getTelaquaWarehouse();
    const body = { ...req.query, ...(req.body || {}) };
    const destination = String(body.destination_pin || body.pincode || "").trim();
    if (!/^\d{6}$/.test(destination)) return res.status(400).json({ success: false, message: "Destination pincode must be 6 digits." });
    const orderId = idOf(body.order_id);
    if (orderId) {
      if (!await orderById(orderId)) return res.status(404).json({ success: false, message: "Order not found." });
      shipment = await ensureShipment(orderId);
    }
    const data = await getExpectedTat({ origin_pin: warehouse.pincode, destination_pin: destination, mot: clean(body.mot || "S") });
    assertDelhiveryAccepted(data, "tat");
    const edd = findResponseValue(data, ["expected_delivery_date", "ExpectedDeliveryDate", "edd", "EDD"]);
    const tat = findResponseValue(data, ["tat", "TAT", "days", "transit_days", "expected_tat"]);
    if (edd == null && tat == null) {
      const error = new Error("Delhivery returned no estimated date or transit time.");
      error.code = "DELHIVERY_INVALID_RESPONSE";
      throw error;
    }
    if (shipment) {
      await query("UPDATE shipments SET expected_delivery_date=?, estimated_tat=?, tat_checked_at=NOW(), tat_response=?, last_error=NULL WHERE id=?", [mysqlDate(edd), tat == null ? null : String(tat), asJson(data), shipment.id]);
    }
    return res.json({ success: true, expected_delivery_date: edd, estimated_tat: tat, data });
  } catch (error) { await recordShipmentError(shipment?.id, error); return apiError(res, error, "Unable to retrieve delivery estimate"); }
}

export async function calculateRate(req, res) {
  let shipment = null;
  try {
    const warehouse = getTelaquaWarehouse();
    const defaults = getTelaquaProductDefaults();
    const body = { ...req.query, ...(req.body || {}) };
    const destination = String(body.d_pin || body.pincode || "").trim();
    if (!/^\d{6}$/.test(destination)) return res.status(400).json({ success: false, message: "Destination pincode must be 6 digits." });
    const orderId = idOf(body.order_id);
    if (orderId) {
      if (!await orderById(orderId)) return res.status(404).json({ success: false, message: "Order not found." });
      shipment = await ensureShipment(orderId);
    }
    const weight = Number(body.cgm || defaults.weightGm);
    const data = await getShippingRate({ md: body.md || "S", cgm: weight, o_pin: warehouse.pincode, d_pin: destination, ss: body.ss || "Delivered" });
    assertDelhiveryAccepted(data, "rate");
    const charge = Number(findResponseValue(data, ["total_amount", "gross_amount", "total", "charge", "amount"]));
    if (!Number.isFinite(charge)) {
      const error = new Error("Delhivery returned no usable shipping charge.");
      error.code = "DELHIVERY_INVALID_RESPONSE";
      throw error;
    }
    if (shipment) {
      await query("UPDATE shipments SET shipping_charge=?, rate_calculated_at=NOW(), rate_response=?, last_error=NULL WHERE id=?", [charge, asJson(data), shipment.id]);
    }
    return res.json({ success: true, shipping_charge: charge, calculated_at: new Date().toISOString(), data });
  } catch (error) { await recordShipmentError(shipment?.id, error); return apiError(res, error, "Unable to calculate shipping charge"); }
}

export async function generateWaybill(req, res) {
  const token = crypto.randomUUID();
  let shipment;
  try {
    const orderId = idOf(req.body?.order_id || req.body?.orderId);
    if (!orderId) return res.status(400).json({ success: false, message: "order_id is required." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const order = await orderById(orderId, client);
      if (!order) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Order not found." });
      }
      shipment = await shipmentForOrder(orderId, client, true) || await ensureShipment(orderId, client);
      assertShipmentEnvironment(shipment);
      if (shipment.waybill_number) {
        await client.query("COMMIT");
        return res.json({ success: true, already_generated: true, waybill: shipment.waybill_number, shipment });
      }
      if (shipment.waybill_processing_token && shipment.waybill_processing_started_at && Date.now() - new Date(shipment.waybill_processing_started_at).getTime() < 10 * 60 * 1000) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: "Waybill generation is already in progress." });
      }
      await client.query(
        "UPDATE shipments SET waybill_processing_token=?, waybill_processing_started_at=NOW(), last_error=NULL WHERE id=?",
        [token, shipment.id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    if (!isLiveFulfillmentEnabled()) {
      await query(
        "UPDATE shipments SET waybill_processing_token=NULL, waybill_processing_started_at=NULL WHERE id=? AND waybill_processing_token=?",
        [shipment.id, token]
      );
      return res.status(200).json({
        success: true,
        pending: true,
        already_generated: false,
        waybill: null,
        shipment_id: shipment.id,
        message: LIVE_FULFILLMENT_PAUSED_MESSAGE,
      });
    }

    const data = await getWaybills(1);
    assertDelhiveryAccepted(data, "waybill");
    const waybill = firstWaybill(data);
    if (!waybill) throw Object.assign(new Error("Delhivery returned no valid waybill."), { code: "DELHIVERY_INVALID_RESPONSE" });
    const saved = await query(
      "UPDATE shipments SET waybill_number=?, fulfillment_status='ready_to_ship', shipment_status='Waybill Generated', waybill_processing_token=NULL, waybill_processing_started_at=NULL, last_error=NULL WHERE id=? AND waybill_number IS NULL AND waybill_processing_token=?",
      [waybill, shipment.id, token]
    );
    if (saved.rowCount !== 1) throw Object.assign(new Error("Waybill could not be saved safely; refresh the shipment before retrying."), { httpStatus: 409, publicMessage: "Waybill could not be saved safely; refresh the shipment before retrying." });
    await query("UPDATE orders SET fulfillment_status='ready_to_ship' WHERE id=?", [orderId]);
    return res.status(201).json({ success: true, message: "Waybill generated.", waybill, shipment_id: shipment.id, data });
  } catch (error) {
    if (shipment?.id) {
      await query(
        "UPDATE shipments SET waybill_processing_token=NULL, waybill_processing_started_at=NULL WHERE id=? AND waybill_processing_token=?",
        [shipment.id, token]
      ).catch(() => {});
      await recordShipmentError(shipment.id, error);
    }
    if (error?.code === "ER_DUP_ENTRY") return res.status(409).json({ success: false, message: "Waybill is already assigned." });
    return apiError(res, error, "Unable to generate waybill");
  }
}

function buildShipmentPayload(order, shipment, warehouse, product) {
  const quantity = Math.max(1, Number(order.quantity) || 1);
  const paymentMode = /cod|cash/i.test(String(order.payment_method || "")) ? "COD" : "Pre-paid";
  const item = {
    name: clean(order.customer_name), add: clean(order.address), city: clean(order.city), state: clean(order.state),
    pin: String(order.pincode), country: "India", phone: String(order.phone), order: String(order.order_number || order.id),
    payment_mode: paymentMode, products_desc: clean(product.name), quantity: String(quantity),
    total_amount: Number(order.final_total ?? order.total_amount), weight: String(product.weightGm * quantity),
    waybill: shipment.waybill_number,
  };
  if (order.email) item.email = String(order.email);
  if (paymentMode === "COD") item.cod_amount = String(item.total_amount);
  return { pickup_location: { name: warehouse.name, add: warehouse.address, city: warehouse.city, state: warehouse.state, pin: warehouse.pincode, phone: warehouse.phone, country: "India" }, shipments: [item] };
}

export async function createOrderShipment(req, res) {
  const orderId = idOf(req.params.orderId || req.body?.order_id || req.body?.orderId);
  if (!orderId) return res.status(400).json({ success: false, message: "Valid order id is required." });
  const token = crypto.randomUUID();
  const client = await pool.connect();
  let shipment;
  let order;
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM orders WHERE id=? LIMIT 1 FOR UPDATE", [orderId]);
    order = found.rows[0];
    if (!order) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Order not found." }); }
    if (!canFulfillOrder(order)) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "Only paid prepaid orders, or COD orders that are Pending or Paid, can be fulfilled." }); }
    shipment = await shipmentForOrder(orderId, client, true) || await ensureShipment(orderId, client);
    assertShipmentEnvironment(shipment);
    if (shipment.shipment_created_at || shipment.shipment_id) { await client.query("COMMIT"); return res.status(409).json({ success: false, message: "Shipment already exists for this order.", shipment }); }
    if (shipment.serviceable === 0) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "Shipment cannot be created because the destination pincode is not serviceable." }); }
    if (!shipment.waybill_number) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "Generate a waybill before creating the shipment." }); }
    if (shipment.processing_token && shipment.processing_started_at && Date.now() - new Date(shipment.processing_started_at).getTime() < 10 * 60 * 1000) {
      await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "Shipment creation is already in progress." });
    }
    await client.query("UPDATE shipments SET processing_token=?, processing_started_at=NOW(), last_error=NULL WHERE id=?", [token, shipment.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); client.release(); return apiError(res, error, "Unable to prepare shipment");
  }
  client.release();

  try {
    if (!isLiveFulfillmentEnabled()) {
      await query("UPDATE shipments SET processing_token=NULL, processing_started_at=NULL WHERE id=? AND processing_token=?", [shipment.id, token]);
      return res.status(200).json({
        success: true,
        pending: true,
        message: LIVE_FULFILLMENT_PAUSED_MESSAGE,
        shipment_id: shipment.id,
      });
    }

    const payload = buildShipmentPayload(order, shipment, getTelaquaWarehouse(), getTelaquaProductDefaults());
    const data = await createShipment(payload);
    assertDelhiveryAccepted(data, "shipment_create");
    const identity = shipmentIdentity(data);
    const waybill = identity.waybill || shipment.waybill_number;
    if (!waybill) throw Object.assign(new Error("Delhivery accepted the request but returned no AWB."), { code: "DELHIVERY_INVALID_RESPONSE" });
    await query(
      `UPDATE shipments SET shipment_id=?, waybill_number=?, fulfillment_status='shipment_created', shipment_status=?,
       shipment_created_at=NOW(), shipment_response=?, processing_token=NULL, processing_started_at=NULL, last_error=NULL WHERE id=? AND processing_token=?`,
      [identity.shipmentId, waybill, identity.status, asJson(data), shipment.id, token]
    );
    await query("UPDATE orders SET fulfillment_status='shipment_created' WHERE id=?", [orderId]);
    await writeAudit(shipment.id, adminId(req), "shipment_created", null, { waybill, shipmentId: identity.shipmentId });
    return res.status(201).json({ success: true, message: "Shipment created successfully.", shipment_id: shipment.id, waybill, data });
  } catch (error) {
    await query("UPDATE shipments SET processing_token=NULL, processing_started_at=NULL WHERE id=? AND processing_token=?", [shipment.id, token]).catch(() => {});
    await recordShipmentError(shipment.id, error);
    return apiError(res, error, "Shipment creation failed");
  }
}

export async function getShipment(req, res) {
  try {
    const shipment = await shipmentById(idOf(req.params.shipmentId));
    if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found." });
    const history = await query("SELECT * FROM shipment_tracking_history WHERE shipment_id=? ORDER BY COALESCE(event_time, created_at) ASC", [shipment.id]);
    const audits = await query("SELECT id, admin_id, action, before_data, after_data, created_at FROM shipment_audit_log WHERE shipment_id=? ORDER BY created_at DESC LIMIT 50", [shipment.id]);
    return res.json({ success: true, shipment, tracking_history: history.rows, audit_log: audits.rows });
  } catch (error) { return apiError(res, error, "Unable to load shipment"); }
}

export async function getShipmentTracking(req, res) {
  try {
    const shipment = await shipmentById(idOf(req.params.shipmentId));
    if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found." });
    const history = await query("SELECT * FROM shipment_tracking_history WHERE shipment_id=? ORDER BY COALESCE(event_time, created_at) ASC", [shipment.id]);
    return res.json({ success: true, shipment_id: shipment.id, current_status: shipment.fulfillment_status, history: history.rows });
  } catch (error) { return apiError(res, error, "Unable to load tracking history"); }
}

async function refreshOneShipment(inputShipment, actorId = null) {
  const locked = await acquireShipmentOperation(inputShipment?.id, "tracking");
  const shipment = locked.shipment;
  try {
  if (!shipment.waybill_number) throw Object.assign(new Error("Shipment has no waybill."), { httpStatus: 409, publicMessage: "Shipment has no waybill." });
  const data = await trackShipment(shipment.waybill_number);
  assertDelhiveryAccepted(data, "tracking");
  const summary = trackingSummary(data);
  const events = extractTrackingEvents(data);
  if (!summary.status && events.length === 0) {
    throw Object.assign(new Error("Delhivery returned no tracking status or events for this AWB."), { code: "DELHIVERY_INVALID_RESPONSE" });
  }
  const latestEvent = events.at(-1);
  const latestStatus = summary.status || latestEvent?.status;
  const latestCode = summary.code || latestEvent?.statusCode;
  const incomingStatusAt = mysqlDateTime(summary.statusDateTime || latestEvent?.eventTime);
  const currentEvent = !incomingStatusAt || isStatusEventCurrent(
    shipment.shipment_status_at,
    incomingStatusAt
  );
  let next = currentEvent
    ? mapDelhiveryStatus(latestStatus, latestCode) || shipment.fulfillment_status
    : shipment.fulfillment_status;
  if (!canAdvanceFulfillment(shipment.fulfillment_status, next)) next = shipment.fulfillment_status;
  let eventsAdded = 0;
  for (const event of events) {
    const mapped = mapDelhiveryStatus(event.status, event.statusCode);
    const inserted = await query(
      `INSERT INTO shipment_tracking_history (shipment_id, status, status_code, fulfillment_status, location, instructions, event_time, raw_event)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM DUAL WHERE NOT EXISTS (
         SELECT 1 FROM shipment_tracking_history WHERE shipment_id=? AND status=? AND COALESCE(event_time,'1970-01-01')=COALESCE(?,'1970-01-01') AND COALESCE(location,'')=COALESCE(?,'')
       )`,
      [shipment.id, event.status, event.statusCode || null, mapped, event.location, event.instructions, mysqlDateTime(event.eventTime), asJson(event.raw), shipment.id, event.status, mysqlDateTime(event.eventTime), event.location]
    );
    eventsAdded += inserted.rowCount;
  }
  const ndrReason = next === "ndr" ? (summary.ndrReason || latestEvent?.instructions || null) : shipment.ndr_reason;
  if (currentEvent) {
    await query(
      `UPDATE shipments SET fulfillment_status=?, shipment_status=?, shipment_status_code=?, shipment_status_at=COALESCE(?, shipment_status_at), current_location=?, expected_delivery_date=COALESCE(?, expected_delivery_date),
       last_tracking_update=NOW(), delivered_at=CASE WHEN ?='delivered' THEN COALESCE(delivered_at, ?, NOW()) ELSE delivered_at END,
       ndr_status=CASE WHEN ?='ndr' THEN 'open' ELSE ndr_status END, ndr_reason=?, tracking_response=?, last_error=NULL WHERE id=?`,
      [next, latestStatus, latestCode, incomingStatusAt, summary.location || latestEvent?.location || null, mysqlDate(summary.expectedDeliveryDate), next, mysqlDateTime(summary.deliveredAt || summary.statusDateTime || latestEvent?.eventTime), next, ndrReason, asJson(data), shipment.id]
    );
    await query("UPDATE orders SET fulfillment_status=? WHERE id=?", [next, shipment.order_id]);
    await writeAudit(shipment.id, actorId, "tracking_refreshed", { fulfillment_status: shipment.fulfillment_status }, { fulfillment_status: next });
  } else {
    await query(
      "UPDATE shipments SET last_tracking_update=NOW(), tracking_response=?, last_error=NULL WHERE id=?",
      [asJson(data), shipment.id]
    );
  }
  return { data, status: currentEvent ? latestStatus : shipment.shipment_status, fulfillment_status: next, events_added: eventsAdded, stale_ignored: !currentEvent };
  } finally {
    await releaseShipmentOperation(shipment.id, locked.token);
  }
}

export async function refreshTracking(req, res) {
  let shipment = null;
  try {
    shipment = await shipmentById(idOf(req.params.shipmentId));
    if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found." });
    const result = await refreshOneShipment(shipment, adminId(req));
    return res.json({ success: true, message: "Tracking refreshed.", ...result });
  } catch (error) { await recordShipmentError(shipment?.id, error); return apiError(res, error, "Unable to retrieve tracking information"); }
}

export async function refreshActiveTracking(req, res) {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.body?.limit) || 20));
    const found = await query(
      `SELECT * FROM shipments WHERE waybill_number IS NOT NULL AND fulfillment_status NOT IN ('delivered','cancelled','returned')
       AND environment=? AND (last_tracking_update IS NULL OR last_tracking_update < DATE_SUB(NOW(), INTERVAL 15 MINUTE)) ORDER BY COALESCE(last_tracking_update, created_at) ASC LIMIT ${limit}`,
      [getDelhiveryEnvironment()]
    );
    const results = [];
    for (const shipment of found.rows) {
      try { results.push({ shipment_id: shipment.id, success: true, ...(await refreshOneShipment(shipment, adminId(req))) }); }
      catch (error) {
        await query("UPDATE shipments SET last_error=? WHERE id=?", [String(error?.message || "Tracking refresh failed").slice(0, 2000), shipment.id]).catch(() => {});
        results.push({ shipment_id: shipment.id, success: false, message: error.message });
      }
    }
    return res.json({ success: true, scanned: found.rows.length, results });
  } catch (error) { return apiError(res, error, "Unable to refresh active shipments"); }
}

export async function pickupShipment(req, res) {
  const token = `pickup:${crypto.randomUUID()}`;
  let shipment;
  try {
    const warehouse = getTelaquaWarehouse();
    const pickupDate = String(req.body?.pickup_date || "").trim();
    const pickupTime = String(req.body?.pickup_time || "18:30:00").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) return res.status(400).json({ success: false, message: "pickup_date must be YYYY-MM-DD." });
    if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(pickupTime)) return res.status(400).json({ success: false, message: "pickup_time must be HH:MM or HH:MM:SS." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      shipment = await shipmentById(idOf(req.params.shipmentId), client, true);
      if (!shipment) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Shipment not found." }); }
      assertShipmentEnvironment(shipment);
      if (shipment.pickup_requested_at) { await client.query("COMMIT"); return res.status(409).json({ success: false, message: "Pickup has already been requested.", shipment }); }
      if (!shipment.shipment_created_at || !shipment.waybill_number) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "A created shipment with an AWB is required before requesting pickup." }); }
      if (shipment.processing_token && shipment.processing_started_at && Date.now() - new Date(shipment.processing_started_at).getTime() < 10 * 60 * 1000) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: "Another shipment operation is already in progress." });
      }
      await client.query("UPDATE shipments SET processing_token=?, processing_started_at=NOW(), last_error=NULL WHERE id=?", [token, shipment.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    const payload = { pickup_date: pickupDate, pickup_time: pickupTime, pickup_location: warehouse.name, expected_package_count: Number(req.body?.expected_package_count) || 1 };
    const data = await requestPickup(payload);
    assertDelhiveryAccepted(data, "pickup");
    const reference = findResponseValue(data, ["pickup_id", "pickupId", "request_id", "requestId", "reference"]);
    const scheduledDate = mysqlDate(findResponseValue(data, ["scheduled_date", "pickup_date", "pickupDate"])) || pickupDate;
    const pickupStatus = String(findResponseValue(data, ["pickup_status", "status"]) || "requested").slice(0, 80);
    const accepted = reference || data?.success === true || /success|scheduled|request/i.test(String(data?.message || data?.status || ""));
    if (!accepted) throw Object.assign(new Error("Delhivery did not confirm that the pickup request was accepted."), { code: "DELHIVERY_INVALID_RESPONSE" });
    const saved = await query("UPDATE shipments SET fulfillment_status='pickup_requested', shipment_status='Pickup Requested', pickup_status=?, pickup_requested_at=NOW(), pickup_date=?, pickup_location=?, pickup_reference=?, pickup_response=?, processing_token=NULL, processing_started_at=NULL, last_error=NULL WHERE id=? AND processing_token=?", [pickupStatus, scheduledDate, warehouse.name, reference, asJson(data), shipment.id, token]);
    if (saved.rowCount !== 1) throw Object.assign(new Error("Pickup was accepted but could not be saved safely. Refresh before retrying."), { httpStatus: 409, publicMessage: "Pickup could not be saved safely. Refresh before retrying." });
    await query("UPDATE orders SET fulfillment_status='pickup_requested' WHERE id=?", [shipment.order_id]);
    await writeAudit(shipment.id, adminId(req), "pickup_requested", null, { pickupDate: scheduledDate, reference, pickupStatus });
    return res.json({ success: true, message: "Pickup requested.", pickup_status: pickupStatus, pickup_date: scheduledDate, pickup_reference: reference, data });
  } catch (error) {
    if (shipment?.id) {
      await query("UPDATE shipments SET processing_token=NULL, processing_started_at=NULL WHERE id=? AND processing_token=?", [shipment.id, token]).catch(() => {});
      await recordShipmentError(shipment.id, error);
    }
    return apiError(res, error, "Unable to request pickup");
  }
}

const UPDATE_FIELDS = new Set(["name", "add", "phone", "cod", "gm", "shipment_length", "shipment_width", "shipment_height", "product_details", "pt"]);
export async function updateShipmentDetails(req, res) {
  let shipment = null;
  let operationToken = null;
  try {
    shipment = await shipmentById(idOf(req.params.shipmentId));
    if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found." });
    assertShipmentEnvironment(shipment);
    if (isTerminalFulfillmentStatus(shipment.fulfillment_status)) return res.status(409).json({ success: false, message: "Delivered, cancelled, or returned shipments cannot be updated." });
    const payload = { waybill: shipment.waybill_number };
    for (const [key, value] of Object.entries(req.body || {})) if (UPDATE_FIELDS.has(key) && value !== "" && value != null) payload[key] = value;
    if (Object.keys(payload).length === 1) return res.status(400).json({ success: false, message: "No supported update fields were provided." });
    const locked = await acquireShipmentOperation(shipment.id, "update");
    shipment = locked.shipment;
    operationToken = locked.token;
    if (isTerminalFulfillmentStatus(shipment.fulfillment_status)) throw Object.assign(new Error("Delivered, cancelled, or returned shipments cannot be updated."), { httpStatus: 409, publicMessage: "Delivered, cancelled, or returned shipments cannot be updated." });
    const data = await updateShipment(payload);
    assertDelhiveryAccepted(data, "shipment_update");
    const saved = await query("UPDATE shipments SET shipment_update_response=?, shipment_updated_at=NOW(), processing_token=NULL, processing_started_at=NULL, last_error=NULL WHERE id=? AND processing_token=?", [asJson(data), shipment.id, operationToken]);
    if (saved.rowCount !== 1) throw Object.assign(new Error("Shipment update succeeded but could not be saved safely."), { httpStatus: 409, publicMessage: "Shipment update could not be saved safely. Refresh before retrying." });
    operationToken = null;
    await writeAudit(shipment.id, adminId(req), "shipment_updated", null, payload);
    return res.json({ success: true, message: "Shipment updated.", data });
  } catch (error) {
    await releaseShipmentOperation(shipment?.id, operationToken);
    await recordShipmentError(shipment?.id, error);
    return apiError(res, error, "Unable to update shipment");
  }
}

export async function getNdr(req, res) {
  try {
    const shipment = await shipmentById(idOf(req.params.shipmentId));
    if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found." });
    const audits = await query("SELECT action, after_data, created_at FROM shipment_audit_log WHERE shipment_id=? AND action LIKE 'ndr_%' ORDER BY created_at DESC", [shipment.id]);
    const actions = shipment.fulfillment_status === "ndr" ? ["RE-ATTEMPT", "DEFER_DLV", "EDIT_DETAILS"] : [];
    return res.json({ success: true, ndr_status: shipment.ndr_status, ndr_reason: shipment.ndr_reason, latest_attempt: shipment.last_tracking_update, actions, history: audits.rows });
  } catch (error) { return apiError(res, error, "Unable to load NDR details"); }
}

export async function submitNdr(req, res) {
  let shipment = null;
  let operationToken = null;
  try {
    shipment = await shipmentById(idOf(req.params.shipmentId));
    if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found." });
    assertShipmentEnvironment(shipment);
    if (shipment.fulfillment_status !== "ndr") return res.status(409).json({ success: false, message: "NDR actions are available only while the shipment is in NDR." });
    const act = String(req.body?.act || "").trim().toUpperCase();
    if (!['RE-ATTEMPT', 'DEFER_DLV', 'EDIT_DETAILS'].includes(act)) return res.status(400).json({ success: false, message: "Unsupported NDR action." });
    const item = { waybill: shipment.waybill_number, act };
    if (req.body?.action_data) item.action_data = req.body.action_data;
    const locked = await acquireShipmentOperation(shipment.id, "ndr");
    shipment = locked.shipment;
    operationToken = locked.token;
    if (shipment.fulfillment_status !== "ndr") throw Object.assign(new Error("NDR actions are available only while the shipment is in NDR."), { httpStatus: 409, publicMessage: "NDR actions are available only while the shipment is in NDR." });
    const data = await updateNdr({ data: [item] });
    assertDelhiveryAccepted(data, "ndr");
    const saved = await query("UPDATE shipments SET ndr_status=?, ndr_response=?, processing_token=NULL, processing_started_at=NULL, last_error=NULL WHERE id=? AND processing_token=?", [`action:${act.toLowerCase()}`, asJson(data), shipment.id, operationToken]);
    if (saved.rowCount !== 1) throw Object.assign(new Error("NDR action succeeded but could not be saved safely."), { httpStatus: 409, publicMessage: "NDR action could not be saved safely. Refresh before retrying." });
    operationToken = null;
    await writeAudit(shipment.id, adminId(req), `ndr_${act.toLowerCase()}`, null, item);
    return res.json({ success: true, message: "NDR action submitted.", data });
  } catch (error) {
    await releaseShipmentOperation(shipment?.id, operationToken);
    await recordShipmentError(shipment?.id, error);
    return apiError(res, error, "Unable to submit NDR action");
  }
}

export async function getOrderLogistics(req, res) {
  try {
    const orderId = idOf(req.params.orderId);
    const order = await orderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    const shipment = await shipmentForOrder(orderId);
    let history = [];
    if (shipment) history = (await query("SELECT * FROM shipment_tracking_history WHERE shipment_id=? ORDER BY COALESCE(event_time, created_at) ASC", [shipment.id])).rows;
    return res.json({ success: true, order_id: orderId, payment_status: order.payment_status, fulfillment_status: shipment?.fulfillment_status || order.fulfillment_status || "unfulfilled", shipment, tracking_history: history });
  } catch (error) { return apiError(res, error, "Unable to load order logistics"); }
}

async function compatibilityShipment(req) {
  const body = { ...req.query, ...(req.body || {}) };
  const orderId = idOf(body.order_id || body.orderId);
  if (orderId) return shipmentForOrder(orderId);
  const waybill = String(body.waybill || body.wbns || body.data?.[0]?.waybill || "").trim();
  if (!waybill) return null;
  const found = await query("SELECT * FROM shipments WHERE waybill_number=? LIMIT 1", [waybill]);
  return found.rows[0] || null;
}

async function runCompatibilityShipmentAction(req, res, handler, transformBody = null) {
  try {
    const shipment = await compatibilityShipment(req);
    if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found. Use an order_id or stored waybill." });
    req.params = { ...(req.params || {}), shipmentId: String(shipment.id) };
    if (transformBody) req.body = transformBody(req.body || {});
    return handler(req, res);
  } catch (error) {
    return apiError(res, error, "Unable to resolve shipment");
  }
}

export const compatibilityUpdateShipment = (req, res) => runCompatibilityShipmentAction(req, res, updateShipmentDetails);
export const compatibilityTrackShipment = (req, res) => runCompatibilityShipmentAction(req, res, refreshTracking);
export const compatibilityPickup = (req, res) => runCompatibilityShipmentAction(req, res, pickupShipment);
export const compatibilityNdr = (req, res) => runCompatibilityShipmentAction(
  req,
  res,
  submitNdr,
  (body) => {
    const item = Array.isArray(body.data) ? body.data[0] || {} : body;
    return { act: item.act, action_data: item.action_data };
  }
);

export { refreshOneShipment };
