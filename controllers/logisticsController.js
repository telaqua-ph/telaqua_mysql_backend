import crypto from "node:crypto";
import { pool, query } from "../config/db.js";
import {
  getDelhiveryEnvironment,
  getSafeDelhiveryConfig,
  getTelaquaProductDefaults,
  getTelaquaWarehouse,
} from "../config/delhiveryConfig.js";
import {
  checkPincodeServiceability,
  createClientWarehouse,
  createShipment,
  generateShippingLabel,
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

function apiError(res, error, fallback = "Unable to complete logistics request") {
  console.error("Logistics error", { code: error?.code, status: error?.status, message: error?.message });
  if (error?.code === "DELHIVERY_CONFIG_ERROR") return res.status(503).json({ success: false, message: error.message });
  if (error?.code === "DELHIVERY_TIMEOUT") return res.status(504).json({ success: false, message: "Delhivery request timed out." });
  if (error?.code === "DELHIVERY_NETWORK_ERROR") return res.status(502).json({ success: false, message: "Delhivery is currently unavailable." });
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

function labelReference(payload) {
  return payload?.packages?.[0]?.pdf_download_link || payload?.pdf_download_link || payload?.label_url || payload?.url || payload?.data?.url || null;
}

function trackingSummary(payload) {
  const root = payload?.ShipmentData?.[0]?.Shipment || payload?.Shipment || payload || {};
  return {
    status: root.Status?.Status || root.Status || root.status || root.CurrentStatus || null,
    code: root.Status?.StatusCode || root.StatusCode || root.status_code || null,
    expectedDeliveryDate: root.ExpectedDeliveryDate || root.EDD || root.expected_delivery_date || null,
    deliveredAt: root.Status?.StatusDateTime || root.DeliveredDate || null,
    ndrReason: root.Status?.Instructions || root.NDRReason || root.ndr_reason || null,
  };
}

async function writeAudit(shipmentId, adminId, action, before, after, client = { query }) {
  await client.query(
    "INSERT INTO shipment_audit_log (shipment_id, admin_id, action, before_data, after_data) VALUES (?, ?, ?, ?, ?)",
    [shipmentId, adminId || null, action, asJson(before), asJson(after)]
  );
}

function adminId(req) {
  return Number(req.user?.admin_id || req.user?.id) || null;
}

export async function getWarehouse(req, res) {
  try {
    const config = getSafeDelhiveryConfig();
    let saved = null;
    try {
      const result = await query("SELECT * FROM logistics_warehouses WHERE is_default = 1 ORDER BY id DESC LIMIT 1");
      saved = result.rows[0] || null;
    } catch (error) {
      if (error?.code !== "ER_NO_SUCH_TABLE") throw error;
    }
    return res.json({ success: true, environment: config.environment, warehouse: saved || config.warehouse, configured: Boolean(config.warehouse) });
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
  try {
    const pincode = String(req.params.pincode || req.body?.pincode || "").trim();
    if (!/^\d{6}$/.test(pincode)) return res.status(400).json({ success: false, message: "Pincode must be 6 digits." });
    const data = await checkPincodeServiceability(pincode);
    const centers = Array.isArray(data?.delivery_codes) ? data.delivery_codes : [];
    const serviceable = centers.length > 0 && !data?.error;
    const orderId = idOf(req.query.order_id || req.body?.order_id);
    if (orderId) {
      const shipment = await ensureShipment(orderId);
      await query("UPDATE shipments SET serviceability_response=?, last_error=NULL WHERE id=?", [asJson(data), shipment.id]);
    }
    return res.json({ success: true, serviceable, message: serviceable ? "Pincode is serviceable." : "Pincode is not serviceable.", data });
  } catch (error) { return apiError(res, error, "Unable to check serviceability"); }
}

export async function checkTat(req, res) {
  try {
    const warehouse = getTelaquaWarehouse();
    const body = { ...req.query, ...(req.body || {}) };
    const destination = String(body.destination_pin || body.pincode || "").trim();
    if (!/^\d{6}$/.test(destination)) return res.status(400).json({ success: false, message: "Destination pincode must be 6 digits." });
    const data = await getExpectedTat({ origin_pin: warehouse.pincode, destination_pin: destination, mot: clean(body.mot || "S") });
    const edd = data?.expected_delivery_date || data?.edd || data?.data?.expected_delivery_date || null;
    const tat = data?.tat || data?.data?.tat || data?.days || null;
    const orderId = idOf(body.order_id);
    if (orderId) {
      const shipment = await ensureShipment(orderId);
      await query("UPDATE shipments SET expected_delivery_date=?, estimated_tat=?, tat_response=? WHERE id=?", [edd || null, tat == null ? null : String(tat), asJson(data), shipment.id]);
    }
    return res.json({ success: true, expected_delivery_date: edd, estimated_tat: tat, data });
  } catch (error) { return apiError(res, error, "Unable to retrieve delivery estimate"); }
}

export async function calculateRate(req, res) {
  try {
    const warehouse = getTelaquaWarehouse();
    const defaults = getTelaquaProductDefaults();
    const body = { ...req.query, ...(req.body || {}) };
    const destination = String(body.d_pin || body.pincode || "").trim();
    if (!/^\d{6}$/.test(destination)) return res.status(400).json({ success: false, message: "Destination pincode must be 6 digits." });
    const weight = Number(body.cgm || defaults.weightGm);
    const data = await getShippingRate({ md: body.md || "S", cgm: weight, o_pin: warehouse.pincode, d_pin: destination, ss: body.ss || "Delivered" });
    const charge = Number(data?.total_amount ?? data?.total ?? data?.charge ?? data?.data?.total_amount);
    const orderId = idOf(body.order_id);
    if (orderId) {
      const shipment = await ensureShipment(orderId);
      await query("UPDATE shipments SET shipping_charge=?, rate_response=? WHERE id=?", [Number.isFinite(charge) ? charge : null, asJson(data), shipment.id]);
    }
    return res.json({ success: true, shipping_charge: Number.isFinite(charge) ? charge : null, data });
  } catch (error) { return apiError(res, error, "Unable to calculate shipping charge"); }
}

export async function generateWaybill(req, res) {
  try {
    const orderId = idOf(req.body?.order_id || req.body?.orderId);
    if (!orderId) return res.status(400).json({ success: false, message: "order_id is required." });
    const order = await orderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    const shipment = await ensureShipment(orderId);
    if (shipment.waybill_number) return res.json({ success: true, already_generated: true, waybill: shipment.waybill_number, shipment });
    const data = await getWaybills(1);
    const waybill = firstWaybill(data);
    if (!waybill) return res.status(502).json({ success: false, message: "Unable to generate waybill." });
    await query("UPDATE shipments SET waybill_number=?, shipment_status='Waybill Generated', last_error=NULL WHERE id=? AND waybill_number IS NULL", [waybill, shipment.id]);
    return res.status(201).json({ success: true, message: "Waybill generated.", waybill, shipment_id: shipment.id, data });
  } catch (error) {
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
    if (String(order.payment_status).toLowerCase() !== "paid") { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "Only paid orders can be fulfilled." }); }
    shipment = await shipmentForOrder(orderId, client, true) || await ensureShipment(orderId, client);
    if (shipment.shipment_created_at || shipment.shipment_id) { await client.query("COMMIT"); return res.status(409).json({ success: false, message: "Shipment already exists for this order.", shipment }); }
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
    const payload = buildShipmentPayload(order, shipment, getTelaquaWarehouse(), getTelaquaProductDefaults());
    const data = await createShipment(payload);
    const identity = shipmentIdentity(data);
    const waybill = identity.waybill || shipment.waybill_number;
    await query(
      `UPDATE shipments SET shipment_id=?, waybill_number=?, fulfillment_status='shipment_created', shipment_status=?,
       shipment_created_at=NOW(), shipment_response=?, processing_token=NULL, processing_started_at=NULL, last_error=NULL WHERE id=? AND processing_token=?`,
      [identity.shipmentId, waybill, identity.status, asJson(data), shipment.id, token]
    );
    await query("UPDATE orders SET fulfillment_status='shipment_created' WHERE id=?", [orderId]);
    await writeAudit(shipment.id, adminId(req), "shipment_created", null, { waybill, shipmentId: identity.shipmentId });
    return res.status(201).json({ success: true, message: "Shipment created successfully.", shipment_id: shipment.id, waybill, data });
  } catch (error) {
    await query("UPDATE shipments SET last_error=?, processing_token=NULL, processing_started_at=NULL WHERE id=? AND processing_token=?", [String(error?.message || "Shipment creation failed").slice(0, 2000), shipment.id, token]).catch(() => {});
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

async function refreshOneShipment(shipment, actorId = null) {
  if (!shipment.waybill_number) throw Object.assign(new Error("Shipment has no waybill."), { httpStatus: 409, publicMessage: "Shipment has no waybill." });
  const data = await trackShipment(shipment.waybill_number);
  const summary = trackingSummary(data);
  const events = extractTrackingEvents(data);
  let next = mapDelhiveryStatus(summary.status, summary.code) || shipment.fulfillment_status;
  if (!canAdvanceFulfillment(shipment.fulfillment_status, next)) next = shipment.fulfillment_status;
  for (const event of events) {
    const mapped = mapDelhiveryStatus(event.status, event.statusCode);
    await query(
      `INSERT INTO shipment_tracking_history (shipment_id, status, status_code, fulfillment_status, location, instructions, event_time, raw_event)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM DUAL WHERE NOT EXISTS (
         SELECT 1 FROM shipment_tracking_history WHERE shipment_id=? AND status=? AND COALESCE(event_time,'1970-01-01')=COALESCE(?,'1970-01-01') AND COALESCE(location,'')=COALESCE(?,'')
       )`,
      [shipment.id, event.status, event.statusCode || null, mapped, event.location, event.instructions, mysqlDateTime(event.eventTime), asJson(event.raw), shipment.id, event.status, mysqlDateTime(event.eventTime), event.location]
    );
  }
  const ndrReason = next === "ndr" ? (summary.ndrReason || events.at(-1)?.instructions || null) : shipment.ndr_reason;
  await query(
    `UPDATE shipments SET fulfillment_status=?, shipment_status=?, shipment_status_code=?, expected_delivery_date=COALESCE(?, expected_delivery_date),
     last_tracking_update=NOW(), delivered_at=CASE WHEN ?='delivered' THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
     ndr_status=CASE WHEN ?='ndr' THEN 'open' ELSE ndr_status END, ndr_reason=?, tracking_response=?, last_error=NULL WHERE id=?`,
    [next, summary.status, summary.code, mysqlDate(summary.expectedDeliveryDate), next, next, ndrReason, asJson(data), shipment.id]
  );
  await query("UPDATE orders SET fulfillment_status=? WHERE id=?", [next, shipment.order_id]);
  await writeAudit(shipment.id, actorId, "tracking_refreshed", { fulfillment_status: shipment.fulfillment_status }, { fulfillment_status: next });
  return { data, status: summary.status, fulfillment_status: next, events_added: events.length };
}

export async function refreshTracking(req, res) {
  try {
    const shipment = await shipmentById(idOf(req.params.shipmentId));
    if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found." });
    const result = await refreshOneShipment(shipment, adminId(req));
    return res.json({ success: true, message: "Tracking refreshed.", ...result });
  } catch (error) { return apiError(res, error, "Unable to retrieve tracking information"); }
}

export async function refreshActiveTracking(req, res) {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.body?.limit) || 20));
    const found = await query(
      `SELECT * FROM shipments WHERE waybill_number IS NOT NULL AND fulfillment_status NOT IN ('delivered','cancelled','returned')
       AND (last_tracking_update IS NULL OR last_tracking_update < DATE_SUB(NOW(), INTERVAL 15 MINUTE)) ORDER BY COALESCE(last_tracking_update, created_at) ASC LIMIT ${limit}`
    );
    const results = [];
    for (const shipment of found.rows) {
      try { results.push({ shipment_id: shipment.id, success: true, ...(await refreshOneShipment(shipment, adminId(req))) }); }
      catch (error) { results.push({ shipment_id: shipment.id, success: false, message: error.message }); }
    }
    return res.json({ success: true, scanned: found.rows.length, results });
  } catch (error) { return apiError(res, error, "Unable to refresh active shipments"); }
}

export async function shipmentLabel(req, res) {
  try {
    const shipment = await shipmentById(idOf(req.params.shipmentId));
    if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found." });
    if (!shipment.waybill_number) return res.status(409).json({ success: false, message: "Generate a waybill first." });
    const data = await generateShippingLabel(shipment.waybill_number);
    const url = labelReference(data);
    await query("UPDATE shipments SET shipping_label_url=?, label_response=? WHERE id=?", [url, asJson(data), shipment.id]);
    return res.json({ success: true, message: "Shipping label generated.", label_url: url, data });
  } catch (error) { return apiError(res, error, "Unable to generate shipping label"); }
}

export async function pickupShipment(req, res) {
  try {
    const shipment = await shipmentById(idOf(req.params.shipmentId));
    if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found." });
    if (shipment.pickup_requested_at) return res.status(409).json({ success: false, message: "Pickup has already been requested." });
    if (!shipment.shipment_created_at) return res.status(409).json({ success: false, message: "Create the shipment before requesting pickup." });
    const warehouse = getTelaquaWarehouse();
    const pickupDate = String(req.body?.pickup_date || "").trim();
    const pickupTime = String(req.body?.pickup_time || "18:30:00").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) return res.status(400).json({ success: false, message: "pickup_date must be YYYY-MM-DD." });
    const payload = { pickup_date: pickupDate, pickup_time: pickupTime, pickup_location: warehouse.name, expected_package_count: Number(req.body?.expected_package_count) || 1 };
    const data = await requestPickup(payload);
    const reference = data?.pickup_id || data?.request_id || data?.data?.pickup_id || null;
    await query("UPDATE shipments SET fulfillment_status='pickup_requested', shipment_status='Pickup Requested', pickup_requested_at=NOW(), pickup_date=?, pickup_location=?, pickup_reference=?, pickup_response=? WHERE id=?", [pickupDate, warehouse.name, reference, asJson(data), shipment.id]);
    await query("UPDATE orders SET fulfillment_status='pickup_requested' WHERE id=?", [shipment.order_id]);
    await writeAudit(shipment.id, adminId(req), "pickup_requested", null, { pickupDate, reference });
    return res.json({ success: true, message: "Pickup requested.", pickup_reference: reference, data });
  } catch (error) { return apiError(res, error, "Unable to request pickup"); }
}

const UPDATE_FIELDS = new Set(["name", "add", "phone", "cod", "gm", "shipment_length", "shipment_width", "shipment_height", "product_details", "pt"]);
export async function updateShipmentDetails(req, res) {
  try {
    const shipment = await shipmentById(idOf(req.params.shipmentId));
    if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found." });
    if (isTerminalFulfillmentStatus(shipment.fulfillment_status)) return res.status(409).json({ success: false, message: "Delivered, cancelled, or returned shipments cannot be updated." });
    const payload = { waybill: shipment.waybill_number };
    for (const [key, value] of Object.entries(req.body || {})) if (UPDATE_FIELDS.has(key) && value !== "" && value != null) payload[key] = value;
    if (Object.keys(payload).length === 1) return res.status(400).json({ success: false, message: "No supported update fields were provided." });
    const data = await updateShipment(payload);
    await writeAudit(shipment.id, adminId(req), "shipment_updated", null, payload);
    return res.json({ success: true, message: "Shipment updated.", data });
  } catch (error) { return apiError(res, error, "Unable to update shipment"); }
}

export async function getNdr(req, res) {
  try {
    const shipment = await shipmentById(idOf(req.params.shipmentId));
    if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found." });
    const audits = await query("SELECT action, after_data, created_at FROM shipment_audit_log WHERE shipment_id=? AND action LIKE 'ndr_%' ORDER BY created_at DESC", [shipment.id]);
    return res.json({ success: true, ndr_status: shipment.ndr_status, ndr_reason: shipment.ndr_reason, latest_attempt: shipment.last_tracking_update, actions: ["RE-ATTEMPT", "DEFER_DLV", "EDIT_DETAILS"], history: audits.rows });
  } catch (error) { return apiError(res, error, "Unable to load NDR details"); }
}

export async function submitNdr(req, res) {
  try {
    const shipment = await shipmentById(idOf(req.params.shipmentId));
    if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found." });
    if (shipment.fulfillment_status !== "ndr") return res.status(409).json({ success: false, message: "NDR actions are available only while the shipment is in NDR." });
    const act = String(req.body?.act || "").trim().toUpperCase();
    if (!['RE-ATTEMPT', 'DEFER_DLV', 'EDIT_DETAILS'].includes(act)) return res.status(400).json({ success: false, message: "Unsupported NDR action." });
    const item = { waybill: shipment.waybill_number, act };
    if (req.body?.action_data) item.action_data = req.body.action_data;
    const data = await updateNdr({ data: [item] });
    await query("UPDATE shipments SET ndr_status=?, ndr_response=? WHERE id=?", [`action:${act.toLowerCase()}`, asJson(data), shipment.id]);
    await writeAudit(shipment.id, adminId(req), `ndr_${act.toLowerCase()}`, null, item);
    return res.json({ success: true, message: "NDR action submitted.", data });
  } catch (error) { return apiError(res, error, "Unable to submit NDR action"); }
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

export { refreshOneShipment };
