import { pool, query } from "../config/db.js";
import { normalizeCourierAssignment } from "../services/courierAssignment.js";
import farmerIntelBasemap from "../utils/farmerIntelBasemap.js";
import { runPincodeGeocodeSync } from "../services/pincodeGeocodeService.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PIN_RE = /^[0-9A-Za-z -]{3,10}$/;
const MAX_PAGE_SIZE = 50;

function cleanText(value, limit = 120) {
  return String(value ?? "").trim().slice(0, limit);
}

export function parseMapFilters(source = {}) {
  const from = cleanText(source.from, 10);
  const to = cleanText(source.to, 10);
  const validDate = (value) => {
    if (!DATE_RE.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) {
    throw Object.assign(new Error("Use a valid from/to date range."), { httpStatus: 422 });
  }
  const status = cleanText(source.status, 24).toLowerCase();
  if (status && !["all", "delivered", "returned", "pending"].includes(status)) {
    throw Object.assign(new Error("Invalid status filter."), { httpStatus: 422 });
  }
  const district = cleanText(source.district, 120);
  return { from: from || null, to: to || null, status: status || "all", district: district || null };
}

export function getMapBasemap(_req, res) {
  return res.json({ success: true, basemap: farmerIntelBasemap });
}

// Only real orders appear on the map: COD orders (paid or still to collect) and
// online orders whose payment is Paid. Unpaid/failed Razorpay checkouts (Leads)
// are excluded. Cancelled orders stay in, matching the Dashboard's Total Orders.
export const CONFIRMED_ORDER_SQL = `(
    LOWER(TRIM(COALESCE(o.payment_mode, ''))) = 'cod'
    OR (
      LOWER(TRIM(COALESCE(o.payment_mode, ''))) NOT IN ('cod', 'razorpay')
      AND LOWER(TRIM(COALESCE(o.payment_method, ''))) IN ('cod', 'cash on delivery', 'cash_on_delivery')
    )
    OR LOWER(TRIM(COALESCE(o.payment_status, ''))) = 'paid'
  )`;

// One row per order: shipment state is calculated with EXISTS to avoid
// double-counting an order that has several shipment rows.
export function buildMapScope(filters) {
  const params = [];
  const dateSql = [];
  // Do not depend on MySQL timezone tables being installed on Hostinger.
  // Stored order timestamps are UTC; this is the same IST calendar-day rule.
  if (filters.from) { dateSql.push("DATE(DATE_ADD(o.created_at, INTERVAL 330 MINUTE)) >= ?"); params.push(filters.from); }
  if (filters.to) { dateSql.push("DATE(DATE_ADD(o.created_at, INTERVAL 330 MINUTE)) <= ?"); params.push(filters.to); }
  if (filters.district) {
    dateSql.push("COALESCE((SELECT NULLIF(TRIM(pg.district), '') FROM pincode_geocodes pg WHERE pg.pincode = TRIM(o.pincode) LIMIT 1), NULLIF(TRIM(o.city), '')) = ?");
    params.push(filters.district);
  }
  // Delivery state can live on the shipments table (current courier flow) or only
  // on the order row (older Delhivery orders and manual/admin status updates).
  // Read both so delivered/returned match the Orders page and the Dashboard.
  const returned = `(LOWER(TRIM(COALESCE(o.fulfillment_status, ''))) IN ('rto','returned')
    OR EXISTS (SELECT 1 FROM shipments sr WHERE sr.order_id = o.id AND LOWER(COALESCE(sr.fulfillment_status, '')) IN ('rto','returned')))`;
  const delivered = `(LOWER(TRIM(COALESCE(o.fulfillment_status, ''))) = 'delivered'
    OR EXISTS (SELECT 1 FROM shipments sd WHERE sd.order_id = o.id AND LOWER(COALESCE(sd.fulfillment_status, '')) = 'delivered'))`;
  let statusSql = "";
  if (filters.status === "delivered") statusSql = ` AND ${delivered} AND NOT ${returned}`;
  if (filters.status === "returned") statusSql = ` AND ${returned}`;
  if (filters.status === "pending") statusSql = ` AND NOT ${delivered} AND NOT ${returned}`;
  return {
    where: `WHERE (o.is_test_order = 0 OR o.is_test_order IS NULL) AND ${CONFIRMED_ORDER_SQL}${dateSql.length ? ` AND ${dateSql.join(" AND ")}` : ""}${statusSql}`,
    params,
    delivered,
    returned,
  };
}

function locationColumns() {
  return `NULLIF(TRIM(o.pincode), '') AS pincode,
          COALESCE(NULLIF(TRIM(g.district), ''), NULLIF(TRIM(o.city), '')) AS district,
          COALESCE(NULLIF(TRIM(g.state), ''), NULLIF(TRIM(o.state), '')) AS state,
          g.latitude, g.longitude`;
}

function aggregateSelect(scope) {
  return `COUNT(*) AS total_orders,
    COALESCE(SUM(o.quantity), 0) AS total_units,
    COALESCE(SUM(CASE WHEN ${scope.delivered} AND NOT ${scope.returned} THEN 1 ELSE 0 END), 0) AS delivered_orders,
    COALESCE(SUM(CASE WHEN ${scope.returned} THEN 1 ELSE 0 END), 0) AS returned_orders,
    COALESCE(SUM(CASE WHEN NOT ${scope.delivered} AND NOT ${scope.returned} THEN 1 ELSE 0 END), 0) AS pending_orders,
    COALESCE(SUM(COALESCE(o.final_total, o.total_amount)), 0) AS revenue`;
}

function returnRate(row) {
  const denominator = Number(row.delivered_orders || 0) + Number(row.returned_orders || 0);
  return denominator ? Math.round((Number(row.returned_orders || 0) / denominator) * 10000) / 100 : null;
}

function rowsWithRates(rows) {
  return rows.map((row) => ({ ...row, return_rate: returnRate(row) }));
}

export async function getMapSummary(req, res) {
  try {
    const filters = parseMapFilters(req.query);
    const scope = buildMapScope(filters);
    const totals = await query(`SELECT ${aggregateSelect(scope)} FROM orders o ${scope.where}`, scope.params);
    const locations = await query(
      `SELECT ${locationColumns()}, ${aggregateSelect(scope)}
       FROM orders o
       LEFT JOIN pincode_geocodes g ON g.pincode = TRIM(o.pincode)
       ${scope.where}
       GROUP BY TRIM(o.pincode), district, state, g.latitude, g.longitude
       ORDER BY total_orders DESC, pincode ASC`,
      scope.params
    );
    const allLocations = rowsWithRates(locations.rows);
    const unmapped = allLocations.filter((row) => !row.pincode || row.latitude == null || row.longitude == null);
    const mapped = allLocations.filter((row) => row.pincode && row.latitude != null && row.longitude != null);
    // New pincodes without a coordinate: look them up in the background so the
    // dots appear on the next refresh (the 15-minute worker also does this).
    if (unmapped.some((row) => row.pincode)) setImmediate(() => { runPincodeGeocodeSync().catch(() => {}); });
    const districts = rowsWithRates((await query(
      `SELECT COALESCE(NULLIF(TRIM(g.district), ''), NULLIF(TRIM(o.city), ''), 'Unknown') AS district,
              COALESCE(NULLIF(TRIM(g.state), ''), NULLIF(TRIM(o.state), ''), 'Unknown') AS state,
              ${aggregateSelect(scope)}
       FROM orders o LEFT JOIN pincode_geocodes g ON g.pincode = TRIM(o.pincode)
       ${scope.where}
       GROUP BY district, state ORDER BY total_orders DESC, district ASC`, scope.params)).rows);
    return res.json({
      success: true,
      updated_at: new Date().toISOString(),
      refresh_after_seconds: Math.max(15, Number(process.env.FARMER_INTEL_REFRESH_SECONDS) || 60),
      filters: { ...filters, product_scope: "tel-aqua-ph-meter" },
      definitions: {
        product_scope: "The current orders schema has no line-item/product key. The live map is labelled Tel-Aqua pH Meter scope and must not be used for a mixed-product catalogue until line items are available.",
        return_rate: "returned/RTO orders divided by delivered plus returned/RTO orders; pending and unfulfilled orders are excluded from the denominator.",
        dot_precision: "Each dot is a pincode centroid, not a farmer or pond location.",
      },
      totals: { ...totals.rows[0], return_rate: returnRate(totals.rows[0]) },
      locations: mapped,
      districts,
      unmapped: { count: unmapped.reduce((sum, row) => sum + Number(row.total_orders || 0), 0), locations: unmapped },
      pond_area_layer: { available: false, reason: "No pond-area source has been configured." },
    });
  } catch (error) {
    return res.status(error.httpStatus || 500).json({ success: false, message: error.httpStatus ? error.message : "Unable to load Farmer Intel Map." });
  }
}

export async function getPincodeOrders(req, res) {
  try {
    const pincode = cleanText(req.params.pincode, 10);
    if (!PIN_RE.test(pincode)) return res.status(422).json({ success: false, message: "Invalid pincode." });
    const filters = parseMapFilters(req.query);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;
    const scope = buildMapScope(filters);
    const pii = Boolean(req.farmerIntelPermissions?.canViewCustomerData);
    const personal = pii ? "o.customer_name, o.phone" : "NULL AS customer_name, NULL AS phone";
    const count = await query(`SELECT COUNT(*) AS total FROM orders o ${scope.where} AND TRIM(o.pincode) = ?`, [...scope.params, pincode]);
    const result = await query(
      `SELECT o.id, o.order_number, o.created_at, o.quantity, o.payment_method, o.payment_status, o.order_status,
              o.fulfillment_status, ${personal},
              s.id AS shipment_id, s.sequence_no, s.provider, s.courier_name, s.carrier_id,
              s.waybill_number, s.tracking_url, s.shipment_status, s.fulfillment_status AS shipment_fulfillment_status
       FROM orders o
       LEFT JOIN shipments s ON s.order_id = o.id
       ${scope.where} AND TRIM(o.pincode) = ?
       ORDER BY o.created_at DESC, o.id DESC, s.sequence_no ASC LIMIT ? OFFSET ?`,
      [...scope.params, pincode, limit, offset]
    );
    return res.json({ success: true, pincode, page, limit, total: Number(count.rows[0]?.total || 0), can_view_customer_data: pii, orders: result.rows });
  } catch (error) {
    return res.status(error.httpStatus || 500).json({ success: false, message: error.httpStatus ? error.message : "Unable to load pincode orders." });
  }
}

export async function listMissingCouriers(req, res) {
  try {
    const { rows } = await query(
      `SELECT s.id AS shipment_id, s.order_id, s.sequence_no, s.fulfillment_status, s.shipment_status,
              o.order_number, o.created_at
       FROM shipments s JOIN orders o ON o.id = s.order_id
       WHERE (o.is_test_order = 0 OR o.is_test_order IS NULL)
         AND LOWER(COALESCE(s.fulfillment_status, 'unfulfilled')) NOT IN ('unfulfilled')
         AND (NULLIF(TRIM(s.courier_name), '') IS NULL AND NULLIF(TRIM(s.provider), '') IS NULL)
       ORDER BY o.created_at DESC, s.id DESC LIMIT 500`
    );
    return res.json({ success: true, count: rows.length, shipments: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Unable to load missing courier records." });
  }
}

export async function correctShipmentCourier(req, res) {
  if (!req.farmerIntelPermissions?.canManageCouriers) return res.status(403).json({ success: false, message: "You do not have permission to correct couriers." });
  const shipmentId = Number(req.params.shipmentId);
  if (!Number.isInteger(shipmentId) || shipmentId < 1) return res.status(422).json({ success: false, message: "Invalid shipment id." });
  try {
    const assignment = normalizeCourierAssignment(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query("SELECT * FROM shipments WHERE id = ? FOR UPDATE", [shipmentId]);
      const shipment = found.rows[0];
      if (!shipment) return res.status(404).json({ success: false, message: "Shipment not found." });
      const before = { provider: shipment.provider, courier_name: shipment.courier_name, carrier_id: shipment.carrier_id };
      const after = { provider: assignment.provider, courier_name: assignment.carrierName, carrier_id: assignment.carrierId };
      await client.query("UPDATE shipments SET provider = ?, courier_name = ?, carrier_id = ? WHERE id = ?", [after.provider, after.courier_name, after.carrier_id, shipmentId]);
      await client.query("INSERT INTO shipment_audit_log (shipment_id, admin_id, action, before_data, after_data) VALUES (?, ?, 'courier_corrected', ?, ?)", [shipmentId, req.admin.id, JSON.stringify(before), JSON.stringify(after)]);
      await client.query("COMMIT");
      return res.json({ success: true, shipment_id: shipmentId, courier: after });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  } catch (error) {
    return res.status(error.httpStatus || 500).json({ success: false, message: error.httpStatus ? error.message : "Unable to correct courier." });
  }
}
