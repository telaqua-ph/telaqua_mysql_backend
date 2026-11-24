/**
 * services/adminActivityLog.js
 *
 * Admin Activity Log: records WHO changed WHAT in the admin dashboard.
 *
 * One Express middleware (adminActivityLogger) sits in front of every /api route.
 * For each admin request that changes data (POST/PUT/PATCH/DELETE) it:
 *   1. takes a snapshot of the affected order / shipments / inventory / promo row BEFORE,
 *   2. lets the normal handler run,
 *   3. after a successful response, takes the AFTER snapshot,
 *   4. writes one row per order into admin_activity_log with the admin's name and
 *      every field that changed (old -> new).
 *
 * Logging never blocks or breaks the real request: every error is swallowed.
 */

import { query } from "../config/db.js";

export const ACTIVITY_TABLE = "admin_activity_log";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// ---------------------------------------------------------------------------
// Route catalogue: which admin action each URL is, and how to find its order.
// Paths are relative to /api. `skip: true` = never logged (read-only / noise).
// snap: which tables to snapshot -> o = orders, s = shipments, i = inventory, p = promo
// ---------------------------------------------------------------------------
const ROUTES = [
  // ---- noise / read-like actions ----
  { m: "POST", p: /^\/auth\/login$/, skip: true },
  { m: "POST", p: /^\/orders\/export$/, skip: true },
  { m: "POST", p: /^\/orders\/\d+\/mark-seen$/, skip: true },
  { m: "*", p: /^\/admin\/push(\/|$)/, skip: true },
  { m: "PATCH", p: /^\/inventory\/notifications(\/|$)/, skip: true },
  { m: "POST", p: /^\/admin\/logistics\/(tat|rate)$/, skip: true },
  { m: "POST", p: /^\/admin\/logistics\/.*tracking\/refresh$/, skip: true },
  { m: "POST", p: /^\/admin\/logistics\/shipments\/(track-active|\d+\/track)$/, skip: true },
  { m: "POST", p: /^\/(delivery|delhivery)\/tracking$/, skip: true },
  { m: "POST", p: /^\/admin\/farmer-intel\/login$/, skip: true },
  { m: "*", p: /^\/admin\/activity-log(\/|$)/, skip: true },

  // ---- orders ----
  { m: "POST", p: /^\/orders\/leads\/confirm$/, action: "lead_confirmed", label: "Confirmed lead (QR partial payment)", orderFrom: "leadOrResponse", snap: "osi" },
  { m: "POST", p: /^\/orders\/manual-prepaid$/, action: "prepaid_order_added", label: "Added prepaid order (manual payment)", orderFrom: "response", snap: "osi" },
  { m: "POST", p: /^\/orders\/manual-cod$/, action: "cod_order_created", label: "Added COD order", orderFrom: "response", snap: "osi" },
  { m: "PATCH", p: /^\/orders\/cod-payment\/bulk$/, action: "cod_paid_bulk", label: "Marked COD paid (bulk)", orderFrom: "bodyIds", snap: "o" },
  { m: "PATCH", p: /^\/orders\/(\d+)\/cod-payment$/, action: "cod_marked_paid", label: "Marked COD paid", orderFrom: "path", snap: "o" },
  { m: "PATCH", p: /^\/orders\/(\d+)\/shipment-status$/, action: "delivery_status_changed", label: "Changed delivery status", orderFrom: "path", snap: "osi" },
  { m: "PATCH", p: /^\/orders\/(\d+)\/purchased-on$/, action: "purchased_on_changed", label: "Changed purchased-on date", orderFrom: "path", snap: "o" },
  { m: "PATCH", p: /^\/orders\/(\d+)\/delivery-details$/, action: "delivery_details_edited", label: "Edited delivery details", orderFrom: "path", snap: "o" },
  { m: "PUT", p: /^\/orders\/(\d+)$/, action: "order_updated", label: "Updated order", orderFrom: "path", snap: "osi" },
  { m: "DELETE", p: /^\/orders\/(\d+)$/, action: "order_deleted", label: "Deleted order", orderFrom: "path", snap: "osi" },
  { m: "DELETE", p: /^\/orders\/cod-advance\/unpaid\/([^/]+)$/, action: "unpaid_cod_checkout_deleted", label: "Deleted unpaid COD checkout", entity: "cod_checkout" },
  { m: "POST", p: /^\/orders\/cod-advance\/([^/]+)\/retry$/, action: "cod_advance_retried", label: "Retried COD advance order", entity: "cod_advance" },
  { m: "POST", p: /^\/orders\/cod-advance\/([^/]+)\/refund$/, action: "cod_advance_refunded", label: "Refunded COD advance", entity: "cod_advance" },
  { m: "POST", p: /^\/orders\/reconcile-(pending-)?razorpay$/, action: "razorpay_reconciled", label: "Reconciled Razorpay payment" },
  { m: "POST", p: /^\/orders\/(\d+)\/(invoice|retry-invoice)$/, action: "invoice_sent", label: "Generated / sent invoice", orderFrom: "path", snap: "o" },
  { m: "POST", p: /^\/orders\/(\d+)\/invoice\/refresh-hsn$/, action: "invoice_hsn_refreshed", label: "Refreshed invoice HSN", orderFrom: "path", snap: "o" },

  // ---- shipments / couriers ----
  { m: "POST", p: /^\/admin\/logistics\/orders\/(\d+)\/shipment$/, action: "shipment_created", label: "Created shipment", orderFrom: "path", snap: "os" },
  { m: "POST", p: /^\/admin\/logistics\/orders\/(\d+)\/shipment\/reconcile$/, action: "shipment_reconciled", label: "Reconciled shipment", orderFrom: "path", snap: "os" },
  { m: "POST", p: /^\/admin\/logistics\/orders\/(\d+)\/courier-record$/, action: "courier_recorded", label: "Recorded courier & article / AWB number", orderFrom: "path", snap: "os" },
  { m: "POST", p: /^\/admin\/logistics\/indiapost\/orders\/(\d+)\/shipment$/, action: "india_post_booked", label: "Booked India Post shipment", orderFrom: "path", snap: "os" },
  { m: "POST", p: /^\/admin\/logistics\/(shipway|indiapost)\/orders\/(\d+)\/tracking\/send-whatsapp$/, action: "tracking_whatsapp_sent", label: "Sent tracking on WhatsApp", orderFrom: "path2" },
  { m: "POST", p: /^\/admin\/logistics\/shipments\/(\d+)\/pickup$/, action: "pickup_requested", label: "Requested courier pickup", orderFrom: "shipment", snap: "os" },
  { m: "PUT", p: /^\/admin\/logistics\/shipments\/(\d+)$/, action: "shipment_updated", label: "Updated shipment", orderFrom: "shipment", snap: "os" },
  { m: "POST", p: /^\/admin\/logistics\/shipments\/(\d+)\/ndr$/, action: "ndr_submitted", label: "Submitted NDR action", orderFrom: "shipment", snap: "os" },
  { m: "POST", p: /^\/admin\/logistics\/waybill$/, action: "waybill_generated", label: "Generated waybill" },
  { m: "POST", p: /^\/admin\/logistics\/warehouse$/, action: "warehouse_created", label: "Created warehouse" },
  { m: "POST", p: /^\/(delivery|delhivery)\/(shipment\/create|create-shipment)$/, action: "shipment_created", label: "Created shipment", orderFrom: "body", snap: "os" },
  { m: "POST", p: /^\/(delivery|delhivery)\/shipment\/update$/, action: "shipment_updated", label: "Updated shipment", orderFrom: "body", snap: "os" },
  { m: "POST", p: /^\/(delivery|delhivery)\/(pickup|ndr|warehouse\/create)$/, action: "courier_action", label: "Courier action" },
  { m: "PATCH", p: /^\/admin\/farmer-intel\/shipments\/(\d+)\/courier$/, action: "courier_corrected", label: "Corrected shipment courier", orderFrom: "shipment", snap: "s" },

  // ---- inventory ----
  { m: "POST", p: /^\/inventory\/add-stock$/, action: "stock_added", label: "Added stock", snap: "i" },
  { m: "POST", p: /^\/inventory\/adjust$/, action: "stock_adjusted", label: "Adjusted stock", snap: "i" },
  { m: "PATCH", p: /^\/inventory\/([^/]+)\/threshold$/, action: "stock_threshold_changed", label: "Changed low-stock threshold", snap: "i" },

  // ---- promo codes ----
  { m: "POST", p: /^\/promo-codes$/, action: "promo_created", label: "Created promo code", entity: "promo" },
  { m: "PATCH", p: /^\/promo-codes\/(\d+)\/status$/, action: "promo_status_changed", label: "Changed promo code status", entity: "promo", snap: "p" },
  { m: "PUT", p: /^\/promo-codes\/(\d+)$/, action: "promo_updated", label: "Edited promo code", entity: "promo", snap: "p" },

  // ---- own account ----
  { m: "PUT", p: /^\/auth\/profile$/, action: "profile_updated", label: "Updated own profile", entity: "admin" },
  { m: "PUT", p: /^\/auth\/change-password$/, action: "password_changed", label: "Changed own password", entity: "admin" },
];

/** Find the catalogue entry for a request. Unknown admin changes get a generic entry. */
export function matchActivityRoute(method, apiPath) {
  const m = String(method || "").toUpperCase();
  const p = String(apiPath || "").replace(/\/+$/, "") || "/";
  for (const route of ROUTES) {
    if (route.m !== "*" && route.m !== m) continue;
    const match = route.p.exec(p);
    if (!match) continue;
    return { ...route, match };
  }
  return { action: "other_change", label: `${m} ${p}`, match: null };
}

// ---------------------------------------------------------------------------
// Snapshots + diff
// ---------------------------------------------------------------------------
const IGNORED_COLUMN = /(^|_)(updated_at|created_at)$|payload|response|raw|_json$|seen|^last_(tracked|synced|sync|checked)|tracking_data|tracking_events|label_data|password|token|secret/i;

const FIELD_LABELS = {
  payment_status: "Payment status",
  order_status: "Order status",
  status: "Status",
  fulfillment_status: "Delivery status",
  shipment_status: "Shipment status",
  payment_mode: "Payment mode",
  payment_method: "Payment method",
  cod_amount_due: "COD amount due",
  cod_advance_status: "COD advance status",
  cod_collected_at: "COD collected at",
  is_test_order: "Test order",
  purchased_on: "Purchased on",
  customer_name: "Customer name",
  phone: "Phone",
  email: "Email",
  address: "Address",
  current_stock: "Stock",
  low_stock_threshold: "Low-stock threshold",
  awb: "AWB",
  waybill: "Waybill",
  courier_name: "Courier",
  is_active: "Active",
};

export function fieldLabel(column) {
  if (FIELD_LABELS[column]) return FIELD_LABELS[column];
  const text = String(column || "").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return null;
  if (typeof value === "object") {
    try { return JSON.stringify(value).slice(0, 300); } catch { return null; }
  }
  const text = String(value);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** Compare two rows of the same table and list the changed fields. */
export function diffRows(before, after, prefix = "") {
  const changes = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    if (key === "id" || IGNORED_COLUMN.test(key)) continue;
    const from = normalizeValue(before?.[key]);
    const to = normalizeValue(after?.[key]);
    if (from === to) continue;
    // Numeric strings like "1499.00" vs "1499" are the same value.
    if (from !== null && to !== null && from.trim() !== "" && to.trim() !== "" && !Number.isNaN(Number(from)) && Number(from) === Number(to)) continue;
    const group = prefix ? `${prefix.replace(/\.$/, "")} · ` : "";
    changes.push({ field: `${prefix}${key}`, label: `${group}${fieldLabel(key)}`, from, to });
  }
  return changes;
}

/** Diff lists of rows keyed by id (shipments, inventory, promo codes). */
export function diffRowSets(beforeRows = [], afterRows = [], name = "Row") {
  const changes = [];
  const beforeById = new Map(beforeRows.map((r) => [String(r.id), r]));
  const afterById = new Map(afterRows.map((r) => [String(r.id), r]));
  for (const [id, after] of afterById) {
    const before = beforeById.get(id);
    if (!before) {
      changes.push({ field: `${name.toLowerCase()}#${id}`, label: `${name} #${id}`, from: null, to: "created" });
      continue;
    }
    changes.push(...diffRows(before, after, `${name} #${id}.`));
  }
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) changes.push({ field: `${name.toLowerCase()}#${id}`, label: `${name} #${id}`, from: "existed", to: "deleted" });
  }
  return changes;
}

async function safeRows(sql, params) {
  try { return (await query(sql, params)).rows || []; } catch { return []; }
}

function placeholders(list) { return list.map(() => "?").join(","); }

async function takeSnapshot(snap, orderIds, promoId) {
  const result = { orders: [], shipments: [], inventory: [], promo: [] };
  if (snap.includes("o") && orderIds.length) result.orders = await safeRows(`SELECT * FROM orders WHERE id IN (${placeholders(orderIds)})`, orderIds);
  if (snap.includes("s") && orderIds.length) result.shipments = await safeRows(`SELECT * FROM shipments WHERE order_id IN (${placeholders(orderIds)})`, orderIds);
  if (snap.includes("i")) result.inventory = await safeRows("SELECT * FROM inventory", []);
  if (snap.includes("p") && promoId) result.promo = await safeRows("SELECT * FROM promo_codes WHERE id = ?", [promoId]);
  return result;
}

// ---------------------------------------------------------------------------
// Helpers: ids, admin, request body
// ---------------------------------------------------------------------------
function toId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function resolveOrderIdsBefore(route, req) {
  const match = route.match;
  switch (route.orderFrom) {
    case "path": return [toId(match?.[1])].filter(Boolean);
    case "path2": return [toId(match?.[2])].filter(Boolean);
    case "body": return [toId(req.body?.order_id ?? req.body?.orderId)].filter(Boolean);
    case "leadOrResponse":
      return String(req.body?.lead_type || "").toLowerCase() === "online" ? [toId(req.body?.lead_id)].filter(Boolean) : [];
    case "bodyIds": {
      const ids = Array.isArray(req.body?.order_ids) ? req.body.order_ids : [];
      return [...new Set(ids.map(toId).filter(Boolean))].slice(0, 300);
    }
    case "shipment": {
      const shipmentId = toId(match?.[1]);
      if (!shipmentId) return [];
      const rows = await safeRows("SELECT order_id FROM shipments WHERE id = ? LIMIT 1", [shipmentId]);
      return [toId(rows[0]?.order_id)].filter(Boolean);
    }
    default: return [];
  }
}

/** Pull a newly created order id out of a JSON response body. */
export function orderIdFromResponse(body) {
  const data = body?.data ?? body;
  const candidates = [data?.order?.id, data?.id, data?.order_id, data?.orderId, body?.order?.id, body?.order_id];
  for (const c of candidates) { const id = toId(c); if (id) return id; }
  return null;
}

const SECRET_KEY = /pass|token|secret|otp|key|authorization|card|cvv/i;
export function sanitizeBody(body) {
  if (!body || typeof body !== "object") return null;
  const clean = (value, depth) => {
    if (depth > 3) return "…";
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => clean(v, depth + 1));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[hidden]" : clean(v, depth + 1);
      return out;
    }
    if (typeof value === "string" && value.length > 300) return `${value.slice(0, 297)}...`;
    return value;
  };
  try {
    const text = JSON.stringify(clean(body, 0));
    if (!text || text === "{}") return null;
    return text.length > 4000 ? `${text.slice(0, 3997)}...` : text;
  } catch { return null; }
}

const adminCache = new Map();
async function adminIdentity(adminId) {
  const cached = adminCache.get(adminId);
  if (cached && cached.expires > Date.now()) return cached.value;
  const rows = await safeRows("SELECT id, full_name, username, email FROM admins WHERE id = ? LIMIT 1", [adminId]);
  const row = rows[0] || {};
  const value = { name: row.full_name || row.username || null, email: row.email || null };
  adminCache.set(adminId, { value, expires: Date.now() + 10 * 60 * 1000 });
  return value;
}

function clientIp(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return (forwarded || req.ip || req.socket?.remoteAddress || "").slice(0, 64) || null;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------
let tableReady = null;
export function ensureAdminActivityTable() {
  if (!tableReady) {
    tableReady = query(`CREATE TABLE IF NOT EXISTS ${ACTIVITY_TABLE} (
      id BIGINT NOT NULL AUTO_INCREMENT,
      admin_id INT NULL,
      admin_name VARCHAR(150) NULL,
      admin_email VARCHAR(190) NULL,
      action VARCHAR(80) NOT NULL,
      action_label VARCHAR(190) NULL,
      entity_type VARCHAR(40) NULL,
      entity_id VARCHAR(64) NULL,
      order_id INT NULL,
      order_number VARCHAR(40) NULL,
      summary VARCHAR(1000) NULL,
      changes LONGTEXT NULL,
      request_method VARCHAR(10) NULL,
      request_path VARCHAR(255) NULL,
      request_body TEXT NULL,
      status_code INT NULL,
      ip_address VARCHAR(64) NULL,
      user_agent VARCHAR(255) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_aal_created (created_at),
      KEY idx_aal_admin (admin_id, created_at),
      KEY idx_aal_order (order_id, created_at),
      KEY idx_aal_action (action, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`).catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  return tableReady;
}

export function buildSummary(label, changes) {
  if (!changes.length) return label;
  const shown = changes.slice(0, 4).map((c) => `${c.label}: ${c.from ?? "—"} → ${c.to ?? "—"}`).join("; ");
  const more = changes.length > 4 ? ` (+${changes.length - 4} more)` : "";
  return `${label} — ${shown}${more}`.slice(0, 1000);
}

export async function writeActivityRows(rows) {
  if (!rows.length) return;
  await ensureAdminActivityTable();
  for (const r of rows) {
    await query(
      `INSERT INTO ${ACTIVITY_TABLE}
        (admin_id, admin_name, admin_email, action, action_label, entity_type, entity_id, order_id, order_number,
         summary, changes, request_method, request_path, request_body, status_code, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [r.admin_id, r.admin_name, r.admin_email, r.action, r.action_label, r.entity_type, r.entity_id, r.order_id, r.order_number,
        r.summary, r.changes, r.request_method, r.request_path, r.request_body, r.status_code, r.ip_address, r.user_agent]
    );
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
export function activityLogEnabled() {
  return String(process.env.ADMIN_ACTIVITY_LOG_ENABLED ?? "true").toLowerCase() !== "false";
}

function looksLikeAdminRequest(req) {
  const header = req.headers?.authorization || "";
  return typeof header === "string" && header.startsWith("Bearer ");
}

export async function adminActivityLogger(req, res, next) {
  if (!activityLogEnabled() || !MUTATING.has(req.method) || !looksLikeAdminRequest(req)) return next();

  let route;
  let before = null;
  let orderIds = [];
  let promoId = null;
  const apiPath = req.path; // mounted on /api, so this is relative to /api
  try {
    route = matchActivityRoute(req.method, apiPath);
    if (route.skip) return next();
    orderIds = await resolveOrderIdsBefore(route, req);
    if (route.snap?.includes("p")) promoId = toId(route.match?.[1]);
    if (route.snap) before = await takeSnapshot(route.snap, orderIds, promoId);
  } catch {
    return next();
  }

  // Remember the JSON body the handler sends (used to find newly created orders).
  const originalJson = res.json.bind(res);
  res.json = (body) => { res.locals.activityResponseBody = body; return originalJson(body); };

  res.on("finish", () => {
    recordAfterResponse({ req, res, route, before, orderIds, promoId }).catch((error) => {
      console.warn("Admin activity log write failed:", error?.message);
    });
  });
  return next();
}

async function recordAfterResponse({ req, res, route, before, orderIds, promoId }) {
  if (res.statusCode >= 400) return; // only successful changes
  if (req.user?.type === "farmer_intel") return;
  const adminId = toId(req.admin?.id ?? req.user?.admin_id ?? req.user?.id);
  if (!adminId) return; // not an admin token (customer/public request)

  if (route.orderFrom === "response" || (route.orderFrom === "leadOrResponse" && !orderIds.length)) {
    const created = orderIdFromResponse(res.locals.activityResponseBody);
    if (created) orderIds = [created];
  }

  const after = route.snap ? await takeSnapshot(route.snap, orderIds, promoId) : null;
  const admin = await adminIdentity(adminId);
  const common = {
    admin_id: adminId,
    admin_name: admin.name,
    admin_email: admin.email || req.user?.email || null,
    action: route.action,
    action_label: route.label,
    request_method: req.method,
    request_path: String(req.originalUrl || req.url || "").split("?")[0].slice(0, 255),
    request_body: sanitizeBody(req.body),
    status_code: res.statusCode,
    ip_address: clientIp(req),
    user_agent: String(req.headers?.["user-agent"] || "").slice(0, 255) || null,
  };

  // Inventory / promo changes are shared (not per order).
  const sharedChanges = [];
  if (before && after) {
    sharedChanges.push(...diffRowSets(before.inventory, after.inventory, "Inventory"));
    sharedChanges.push(...diffRowSets(before.promo, after.promo, "Promo"));
  }

  const rows = [];
  if (orderIds.length) {
    for (const orderId of orderIds) {
      const o1 = before?.orders.find((r) => Number(r.id) === orderId) || null;
      const o2 = after?.orders.find((r) => Number(r.id) === orderId) || null;
      const changes = [];
      if (before && after) {
        if (!o1 && o2) changes.push({ field: "order", label: "Order", from: null, to: "created" });
        else if (o1 && !o2) changes.push({ field: "order", label: "Order", from: "existed", to: "deleted" });
        else changes.push(...diffRows(o1, o2));
        changes.push(...diffRowSets(
          (before.shipments || []).filter((s) => Number(s.order_id) === orderId),
          (after.shipments || []).filter((s) => Number(s.order_id) === orderId),
          "Shipment"
        ));
      }
      if (orderIds.length === 1) changes.push(...sharedChanges);
      const orderNumber = o2?.order_number || o1?.order_number || null;
      rows.push({
        ...common,
        entity_type: "order",
        entity_id: String(orderId),
        order_id: orderId,
        order_number: orderNumber,
        summary: buildSummary(route.label, changes),
        changes: changes.length ? JSON.stringify(changes) : null,
      });
    }
  } else {
    const entityId = route.match?.[1] ? String(route.match[1]).slice(0, 64) : null;
    rows.push({
      ...common,
      entity_type: route.entity || (route.snap?.includes("i") ? "inventory" : null),
      entity_id: entityId,
      order_id: null,
      order_number: null,
      summary: buildSummary(route.label, sharedChanges),
      changes: sharedChanges.length ? JSON.stringify(sharedChanges) : null,
    });
  }
  await writeActivityRows(rows);
}

// ---------------------------------------------------------------------------
// Reading the log (used by the Activity Log page)
// ---------------------------------------------------------------------------

/** Who may open the Activity Log. ACTIVITY_LOG_VIEWERS = comma list of admin emails and/or ids. Empty = every active admin. */
export function parseViewerList(raw) {
  return String(raw || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function canViewActivityLog(admin, raw = process.env.ACTIVITY_LOG_VIEWERS) {
  const list = parseViewerList(raw);
  if (!list.length) return true;
  const id = String(admin?.id ?? "").toLowerCase();
  const email = String(admin?.email ?? "").toLowerCase();
  return list.includes(id) || Boolean(email && list.includes(email));
}

/** Convert IST calendar dates (YYYY-MM-DD) to a UTC range for created_at filtering. */
export function istDateRangeToUtc(from, to) {
  const valid = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
  const toUtc = (d, endOfDay) => {
    const ms = Date.parse(`${d}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+05:30`);
    return new Date(ms).toISOString().slice(0, 23).replace("T", " ");
  };
  return { fromUtc: valid(from) ? toUtc(from, false) : null, toUtc: valid(to) ? toUtc(to, true) : null };
}

const SELECT_COLUMNS = `id, admin_id, admin_name, admin_email, action, action_label, entity_type, entity_id, order_id, order_number,
  summary, changes, request_method, request_path, status_code, ip_address,
  CONCAT(DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s'), 'Z') AS created_at`;

function mapRow(row) {
  let changes = [];
  if (row.changes) { try { changes = JSON.parse(row.changes); } catch { changes = []; } }
  return { ...row, changes, source: row.source || "activity_log" };
}

export async function listActivity(filters = {}) {
  await ensureAdminActivityTable();
  const where = [];
  const params = [];
  const adminId = toId(filters.adminId);
  if (adminId) { where.push("admin_id = ?"); params.push(adminId); }
  if (filters.action) { where.push("action = ?"); params.push(String(filters.action).slice(0, 80)); }
  const orderIdFilter = toId(filters.orderId);
  if (orderIdFilter) { where.push("order_id = ?"); params.push(orderIdFilter); }
  if (filters.order) {
    const text = String(filters.order).trim().slice(0, 40);
    const digits = text.replace(/\D/g, "");
    if (digits && toId(digits)) { where.push("(order_number LIKE ? OR order_id = ?)"); params.push(`%${text}%`, Number(digits)); }
    else { where.push("order_number LIKE ?"); params.push(`%${text}%`); }
  }
  if (filters.q) {
    where.push("(summary LIKE ? OR admin_name LIKE ? OR admin_email LIKE ?)");
    const q = `%${String(filters.q).slice(0, 100)}%`;
    params.push(q, q, q);
  }
  const { fromUtc, toUtc } = istDateRangeToUtc(filters.from, filters.to);
  if (fromUtc) { where.push("created_at >= ?"); params.push(fromUtc); }
  if (toUtc) { where.push("created_at <= ?"); params.push(toUtc); }

  const limit = Math.min(Math.max(Math.floor(Number(filters.limit)) || 50, 1), 5000);
  const page = Math.max(Math.floor(Number(filters.page)) || 1, 1);
  const offset = (page - 1) * limit;
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRes = await query(`SELECT COUNT(*) AS total FROM ${ACTIVITY_TABLE} ${whereSql}`, params);
  // LIMIT/OFFSET are inlined as validated integers (MariaDB prepared statements dislike bound LIMIT params).
  const listRes = await query(
    `SELECT ${SELECT_COLUMNS} FROM ${ACTIVITY_TABLE} ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return { rows: listRes.rows.map(mapRow), total: Number(totalRes.rows[0]?.total || 0), page, limit };
}

/** Full history for one order: new activity log + older audit logs recorded before this feature existed. */
export async function orderActivity(orderId) {
  await ensureAdminActivityTable();
  const id = toId(orderId);
  if (!id) return [];
  const own = (await query(
    `SELECT ${SELECT_COLUMNS} FROM ${ACTIVITY_TABLE} WHERE order_id = ? ORDER BY created_at DESC, id DESC LIMIT 500`,
    [id]
  )).rows.map(mapRow);

  // Older logs: only entries from before the activity log started, so nothing shows twice.
  const firstRows = await safeRows(`SELECT MIN(created_at) AS first_at FROM ${ACTIVITY_TABLE}`, []);
  const firstAt = firstRows[0]?.first_at || null;
  const cutoffSql = firstAt ? "AND l.created_at < ?" : "";
  const cutoffParams = firstAt ? [firstAt] : [];
  const fmt = "CONCAT(DATE_FORMAT(l.created_at, '%Y-%m-%dT%H:%i:%s'), 'Z')";

  const legacy = [];
  const cod = await safeRows(
    `SELECT l.id, l.admin_id, a.full_name AS admin_name, a.email AS admin_email, l.action, ${fmt} AS created_at
     FROM cod_payment_audit_log l LEFT JOIN admins a ON a.id = l.admin_id
     WHERE l.order_id = ? ${cutoffSql} ORDER BY l.created_at DESC LIMIT 200`,
    [id, ...cutoffParams]
  );
  for (const r of cod) {
    legacy.push({ ...r, id: `cod-${r.id}`, action_label: "Marked COD paid", summary: `Marked COD paid (${r.action})`, changes: [], source: "cod_payment_audit_log" });
  }

  const ship = await safeRows(
    `SELECT l.id, l.admin_id, a.full_name AS admin_name, a.email AS admin_email, l.action, l.before_data, l.after_data, ${fmt} AS created_at
     FROM shipment_audit_log l JOIN shipments s ON s.id = l.shipment_id LEFT JOIN admins a ON a.id = l.admin_id
     WHERE s.order_id = ? AND l.admin_id IS NOT NULL ${cutoffSql} ORDER BY l.created_at DESC LIMIT 200`,
    [id, ...cutoffParams]
  );
  for (const r of ship) {
    let changes = [];
    try { changes = diffRows(JSON.parse(r.before_data || "{}"), JSON.parse(r.after_data || "{}")); } catch { changes = []; }
    legacy.push({
      id: `ship-${r.id}`, admin_id: r.admin_id, admin_name: r.admin_name, admin_email: r.admin_email,
      action: r.action, action_label: "Shipment change", summary: buildSummary(`Shipment: ${r.action}`, changes),
      changes, created_at: r.created_at, source: "shipment_audit_log",
    });
  }

  const delivery = await safeRows(
    `SELECT l.*, a.full_name AS admin_name_join, a.email AS admin_email_join, ${fmt} AS created_at_utc
     FROM order_delivery_audit_log l LEFT JOIN admins a ON a.id = l.admin_id
     WHERE l.order_id = ? ${cutoffSql} ORDER BY l.created_at DESC LIMIT 200`,
    [id, ...cutoffParams]
  );
  for (const r of delivery) {
    let changes = [];
    try {
      const parse = (v) => (typeof v === "string" ? JSON.parse(v) : (v || {}));
      changes = diffRows(parse(r.before_data ?? r.old_values), parse(r.after_data ?? r.new_values));
    } catch { changes = []; }
    legacy.push({
      id: `del-${r.id}`, admin_id: r.admin_id ?? null, admin_name: r.admin_name_join || null, admin_email: r.admin_email_join || null,
      action: r.action || "delivery_details_edited", action_label: "Edited delivery details",
      summary: buildSummary("Edited delivery details", changes), changes, created_at: r.created_at_utc, source: "order_delivery_audit_log",
    });
  }

  return [...own, ...legacy].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
}

export async function listAdminsForFilter() {
  return safeRows("SELECT id, full_name, username, email, is_active FROM admins ORDER BY id", []);
}

export async function listActions() {
  await ensureAdminActivityTable();
  return safeRows(
    `SELECT action, MAX(action_label) AS label, COUNT(*) AS count FROM ${ACTIVITY_TABLE} GROUP BY action ORDER BY label`,
    []
  );
}
