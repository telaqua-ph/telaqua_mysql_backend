import { getShipwayConfig } from "../config/shipwayConfig.js";

const ENDPOINT = "https://app.shipway.com/api/v2orders";
const GET_ORDERS_ENDPOINT = "https://app.shipway.com/api/getorders";
const GET_CARRIERS_ENDPOINT = "https://app.shipway.com/api/getcarrier";
const PINCODE_SERVICEABILITY_ENDPOINT = "https://app.shipway.com/api/pincodeserviceable";
const TIMEOUT_MS = 20_000;

const messageOf = (body, fallback) => String(body?.message || body?.error || body?.errors?.[0]?.message || fallback).replace(/[\r\n]+/g, " ").slice(0, 900);
const valueOf = (body, keys, depth = 0) => {
  if (!body || depth > 5 || typeof body !== "object") return null;
  if (Array.isArray(body)) return body.map((value) => valueOf(value, keys, depth + 1)).find(Boolean) || null;
  for (const key of keys) if (body[key] != null && String(body[key]).trim()) return String(body[key]).trim();
  return Object.values(body).map((value) => valueOf(value, keys, depth + 1)).find(Boolean) || null;
};

function redactResponse(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => redactResponse(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, /email|phone|mobile|address|authorization|license|password/i.test(name) ? "[redacted]" : redactResponse(item, name)]));
  return /authorization|license|password/i.test(key) ? "[redacted]" : value;
}

export function shipwayDiagnostics({ orderNumber, httpStatus = null, body = null, error = null, operation }) {
  const details = {
    operation, order_number: orderNumber, http_status: httpStatus,
    response_body: redactResponse(body), success: body?.success ?? null,
    awb_response_success: body?.awb_response?.success ?? null,
    error_message: messageOf(body, error?.message || "No Shipway error message returned."),
    order_reference: valueOf(body, ["order_id", "orderid", "reference", "shipment_id"]),
    awb: valueOf(body, ["AWB", "awb", "awb_number", "tracking_number"]),
    label_url: valueOf(body, ["shipping_url", "label_url", "shipping_label_url"]),
  };
  console.warn("Shipway diagnostics", details);
  return details;
}

const isTruthyFlag = (value) => value === true || value === 1 || value === "1";
export const isHttpUrl = (value) => {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
};
const NO_ORDER_PATTERN = /^no orders? found\.?$/i;
const NO_COURIER_PATTERN = /no courier found|carrier_id does not exist/i;
export const NO_COURIER_GUIDANCE = "activate a courier and courier priority rule in Shipway";

/** Shipway answers "No Courier Found" when the account has no active courier to auto-assign. */
export function isShipwayNoCourierResponse(body) {
  const texts = [body?.message, body?.error, typeof body?.awb_response === "string" ? body.awb_response : body?.awb_response?.message];
  return texts.some((value) => typeof value === "string" && NO_COURIER_PATTERN.test(value));
}

export function assertShipwayBookingSucceeded(body, context = {}) {
  const awbResponse = body?.awb_response && typeof body.awb_response === "object" ? body.awb_response : {};
  const awb = String(awbResponse.AWB || "").trim();
  const labelUrl = String(awbResponse.shipping_url || "").trim();
  if (isTruthyFlag(body?.success) && isTruthyFlag(awbResponse.success) && awb && isHttpUrl(labelUrl)) {
    return {
      awb,
      labelUrl,
      carrierId: String(awbResponse.carrier_id || "").trim() || null,
      carrierName: String(awbResponse.carrier_name || awbResponse.courier_name || "").trim() || null,
    };
  }
  let safeMessage = messageOf(body, "Shipway did not confirm both order booking and AWB label generation.");
  // Shipway often accepts the order first ("Order has been added successfully") and assigns the
  // courier/AWB a few seconds later. Say so plainly and surface the courier (awb_response) reason.
  const orderCreated = isTruthyFlag(body?.success) && !awb;
  if (orderCreated && !isShipwayNoCourierResponse(body)) {
    const awbText = typeof body?.awb_response === "string"
      ? body.awb_response
      : awbResponse.message || awbResponse.error || "";
    const shipwayText = /added successfully/i.test(safeMessage) ? "" : safeMessage;
    const courierReason = [shipwayText, String(awbText || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300)]
      .filter(Boolean).join("; ");
    safeMessage = `${context.orderNumber ? `Order ${context.orderNumber}` : "The order"} was created in Shipway, but the courier/AWB was not assigned yet` +
      (courierReason ? ` (${courierReason})` : "") +
      (/no shipping services available|A-306|not serviceable|non[- ]serviceable/i.test(courierReason)
        ? ". This courier cannot deliver to this address. Assign another courier to this order in Shipway; the dashboard updates automatically within a few minutes (or press Retry)."
        : ". Do not book it again in Shipway. Press Retry in a minute: it fetches the AWB from Shipway without booking twice.");
  }
  if (isShipwayNoCourierResponse(body)) {
    const courierText = typeof body?.awb_response === "string" ? messageOf({ message: body.awb_response }, "") : "";
    safeMessage = [safeMessage, courierText && courierText !== safeMessage ? courierText : ""].filter(Boolean).join(" ") +
      ` The Shipway account has no active courier: ${NO_COURIER_GUIDANCE}, then retry.`;
  }
  shipwayDiagnostics({ ...context, body, error: { message: safeMessage }, operation: "booking_response" });
  const error = new Error(`Shipway: ${safeMessage}`);
  error.code = "SHIPWAY_PARTIAL_OR_REJECTED";
  error.upstreamBody = body || null;
  if (orderCreated) error.shipwayOrderCreated = true;
  if (isShipwayNoCourierResponse(body)) error.noCourier = true;
  throw error;
}

/** A response explicitly rejecting booking without an AWB cannot be a hidden successful shipment. */
export function isDefinitiveShipwayBookingRejection(error) {
  const body = error?.upstreamBody;
  const awb = valueOf(body, ["AWB", "awb", "awb_number", "tracking_number"]);
  const labelUrl = valueOf(body, ["shipping_url", "label_url", "shipping_label_url"]);
  // A response without either booking artifact cannot put a parcel in transit.
  // It is safe to release its lock so the corrected booking can be retried.
  return error?.code === "SHIPWAY_PARTIAL_OR_REJECTED" && !awb && !labelUrl;
}

/** Exactly one booking request: retries after an uncertain outcome can duplicate a courier order. */
export async function createShipwayShipment(payload) {
  const config = getShipwayConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const authorization = Buffer.from(`${config.email}:${config.licenseKey}`, "utf8").toString("base64");
    const orderNumber = payload.order_id;
    console.info('[Shipway] outgoing booking verification', {
      orderNumber,
      autoAssignment: payload.carrier_id == null,
      carrierId: payload.carrier_id ?? null,
      payloadKeys: Object.keys(payload),
    });
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Basic ${authorization}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`Shipway: ${messageOf(body, `Shipway API returned HTTP ${response.status}`)}`);
      error.code = "SHIPWAY_UPSTREAM_ERROR";
      error.status = response.status;
      error.upstreamBody = body;
      shipwayDiagnostics({ orderNumber: payload.order_id, httpStatus: response.status, body, error, operation: "booking_http_error" });
      throw error;
    }
    return { body, booking: assertShipwayBookingSucceeded(body, { orderNumber: payload.order_id, httpStatus: response.status }) };
  } catch (cause) {
    if (cause?.name === "AbortError") {
      const error = new Error("Shipway booking timed out; its outcome is unknown.");
      error.code = "SHIPWAY_OUTCOME_UNKNOWN";
      throw error;
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

function carrierLookupError(message, { body = null, httpStatus = null, cause = null } = {}) {
  const error = new Error(message);
  error.code = "SHIPWAY_CARRIER_LOOKUP_FAILED";
  error.upstreamBody = body;
  error.status = httpStatus;
  error.cause = cause;
  shipwayDiagnostics({ httpStatus, body, error, operation: "carrier_lookup" });
  return error;
}

/** Read active carriers before booking; carrier IDs are account-specific. */
export async function getShipwayCarriers() {
  const config = getShipwayConfig();
  const authorization = Buffer.from(`${config.email}:${config.licenseKey}`, "utf8").toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(GET_CARRIERS_ENDPOINT, {
      headers: { Authorization: `Basic ${authorization}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (cause) {
    throw carrierLookupError("Shipway carrier lookup could not be completed; the shipment was not booked.", { cause });
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw carrierLookupError(`Shipway carrier lookup returned HTTP ${response.status}.`, { body, httpStatus: response.status });
  }
  if (String(body?.success) !== "1") {
    throw carrierLookupError("Shipway carrier lookup returned an unrecognised response; the shipment was not booked.", { body, httpStatus: response.status });
  }
  if (typeof body?.message === "string" && /^no carrier found\.?$/i.test(body.message.trim())) return [];
  if (!Array.isArray(body?.message)) {
    throw carrierLookupError("Shipway carrier lookup returned an unrecognised response; the shipment was not booked.", { body, httpStatus: response.status });
  }
  return body.message.flatMap((carrier) => {
    const id = String(carrier?.id ?? "").trim();
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) return [];
    return [{ id, name: String(carrier?.name ?? "").trim(), title: String(carrier?.carrier_title ?? "").trim() }];
  });
}

export async function resolveShipwayCarrier() {
  const carriers = await getShipwayCarriers();
  if (!carriers.length) {
    const error = new Error("Shipway: No active Shipway carrier/courier is configured on this account, so the shipment was not booked. Please activate a courier and courier priority rule in Shipway, then retry.");
    error.code = "SHIPWAY_NO_CARRIER";
    throw error;
  }
  const configuredId = String(process.env.SHIPWAY_CARRIER_ID || "").trim();
  if (configuredId) {
    const carrier = carriers.find((item) => item.id === configuredId);
    if (!carrier) {
      const error = new Error(`SHIPWAY_CARRIER_ID ${configuredId} is not active in Shipway. Active carriers: ${carriers.map((item) => `${item.id} (${item.name || item.title || "unnamed"})`).join(", ")}.`);
      error.code = "SHIPWAY_CONFIG_ERROR";
      throw error;
    }
    return { carrierId: carrier.id, carrierName: carrier.name || carrier.title || null, source: "configured" };
  }
  const carrier = carriers[0];
  return { carrierId: carrier.id, carrierName: carrier.name || carrier.title || null, source: "shipway" };
}

/* ---------------------------------------------------------------------------
 * Courier priority + fallback.
 * Ship Order tries couriers in this order: SHIPWAY_CARRIER_PRIORITY (default
 * "amazon,ekart surface"), then every other active Shipway courier.
 * ------------------------------------------------------------------------- */

export const DEFAULT_CARRIER_PRIORITY = "amazon,ekart surface";

const carrierLabel = (carrier) => `${carrier?.name || ""} ${carrier?.title || ""}`.toLowerCase();

/** "ekart surface" matches a courier whose name/title contains both "ekart" and "surface". */
function carrierMatchesTerm(carrier, term) {
  const words = term.toLowerCase().split(/[\s_-]+/).filter(Boolean);
  const label = carrierLabel(carrier);
  return words.length > 0 && words.every((word) => label.includes(word));
}

/** Order active carriers: priority terms first (in the order given), then the rest as Shipway lists them. */
export function rankShipwayCarriers(carriers, priority = process.env.SHIPWAY_CARRIER_PRIORITY) {
  const terms = String(priority ?? "").trim() ? String(priority).split(",") : DEFAULT_CARRIER_PRIORITY.split(",");
  const ranked = [];
  const seen = new Set();
  for (const term of terms.map((item) => item.trim()).filter(Boolean)) {
    const matches = carriers.filter((carrier) => !seen.has(carrier.id) && carrierMatchesTerm(carrier, term));
    // Within one term, prefer a "surface" variant (e.g. "Amazon Surface" over "Amazon Air") unless the term names a mode.
    if (!/surface|air|express/i.test(term)) matches.sort((a, b) => Number(/surface/.test(carrierLabel(b))) - Number(/surface/.test(carrierLabel(a))));
    for (const carrier of matches) { seen.add(carrier.id); ranked.push(carrier); }
  }
  for (const carrier of carriers) if (!seen.has(carrier.id)) { seen.add(carrier.id); ranked.push(carrier); }
  return ranked;
}

function collectCarrierIds(value, ids, depth = 0) {
  if (!value || depth > 6 || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((item) => collectCarrierIds(item, ids, depth + 1)); return; }
  for (const key of ["carrier_id", "courier_id", "id"]) {
    const id = String(value[key] ?? "").trim();
    if (/^\d+$/.test(id) && Number(id) > 0) { ids.add(id); break; }
  }
  for (const item of Object.values(value)) if (item && typeof item === "object") collectCarrierIds(item, ids, depth + 1);
}

/**
 * Best-effort, read-only pincode check. Returns a Set of carrier IDs Shipway says can
 * deliver to the pincode, or null when the answer is unknown (any error or unrecognised
 * body). null never blocks booking; the per-courier fallback still applies.
 */
export async function getShipwayServiceableCarrierIds(pincode, { cod = false, timeoutMs = 8000 } = {}) {
  const pin = String(pincode ?? "").trim();
  if (!/^\d{6}$/.test(pin)) return null;
  try {
    const config = getShipwayConfig();
    const authorization = Buffer.from(`${config.email}:${config.licenseKey}`, "utf8").toString("base64");
    const url = new URL(PINCODE_SERVICEABILITY_ENDPOINT);
    url.searchParams.set("pincode", pin);
    if (cod) url.searchParams.set("payment_type", "C");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, { headers: { Authorization: `Basic ${authorization}`, Accept: "application/json" }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body || [0, "0", false].includes(body.success)) return null;
    const ids = new Set();
    collectCarrierIds(body.message ?? body.data ?? body, ids);
    return ids.size ? ids : null;
  } catch (error) {
    console.warn("[Shipway] Pincode serviceability check skipped", { message: error?.message });
    return null;
  }
}

/**
 * Ordered list of carriers to try for one order. Serviceable carriers keep their
 * priority position; carriers Shipway says cannot serve the pincode are dropped,
 * but only when the check actually recognised at least one active carrier.
 */
export async function resolveShipwayCarrierCandidates({ pincode = null, cod = false } = {}) {
  const carriers = await getShipwayCarriers();
  if (!carriers.length) {
    const error = new Error("Shipway: No active Shipway carrier/courier is configured on this account, so the shipment was not booked. Please activate a courier and courier priority rule in Shipway, then retry.");
    error.code = "SHIPWAY_NO_CARRIER";
    throw error;
  }
  if (String(process.env.SHIPWAY_CARRIER_ID || "").trim()) {
    console.warn("[Shipway] SHIPWAY_CARRIER_ID is ignored for Ship Order; SHIPWAY_CARRIER_PRIORITY decides the courier order.");
  }
  const ranked = rankShipwayCarriers(carriers);
  const serviceable = pincode ? await getShipwayServiceableCarrierIds(pincode, { cod }) : null;
  const filtered = serviceable ? ranked.filter((carrier) => serviceable.has(carrier.id)) : [];
  const list = filtered.length ? filtered : ranked;
  return list.map((carrier) => ({ carrierId: carrier.id, carrierName: carrier.name || carrier.title || null, source: filtered.length ? "serviceable" : "priority" }));
}

const COURIER_UNAVAILABLE_PATTERN = /no shipping services available|A-306|not serviceable|non[- ]?serviceable|unserviceable|serviceability|pincode is not|pin ?code not|no courier found|carrier_id does not exist|courier (?:is )?not available|carrier unavailable|courier unavailable/i;

function errorTexts(error) {
  const body = error?.upstreamBody;
  const awbResponse = body?.awb_response;
  // Upstream Shipway text only: our own wrapper messages always say "not assigned yet".
  return [body?.message, body?.error,
    typeof awbResponse === "string" ? awbResponse : awbResponse?.message, awbResponse?.error]
    .filter((value) => typeof value === "string");
}

/**
 * True when Shipway refused this specific courier (cannot serve the address) and no
 * AWB/label was produced, so trying the next courier cannot create a second shipment.
 * Timeouts and ambiguous outcomes are never treated as a courier refusal.
 */
export function isShipwayCourierUnavailable(error) {
  if (!error || error.code === "SHIPWAY_OUTCOME_UNKNOWN") return false;
  const body = error.upstreamBody;
  if (valueOf(body, ["AWB", "awb", "awb_number", "tracking_number"]) || valueOf(body, ["shipping_url", "label_url", "shipping_label_url"])) return false;
  if (error.code === "SHIPWAY_PARTIAL_OR_REJECTED") {
    return Boolean(error.noCourier) || errorTexts(error).some((text) => COURIER_UNAVAILABLE_PATTERN.test(text));
  }
  if (error.code === "SHIPWAY_UPSTREAM_ERROR" && [400, 409, 422].includes(error.status)) {
    return errorTexts(error).some((text) => COURIER_UNAVAILABLE_PATTERN.test(text));
  }
  return false;
}

/** Shipway refused a re-push because the order id is already present. */
export function isShipwayDuplicateOrderResponse(error) {
  return errorTexts(error).some((text) => /already exists?|duplicate order|order id exists/i.test(text));
}

/** Read-only reconciliation. It never creates, modifies, or cancels a Shipway order. */
export async function findShipwayOrder(orderNumber, { timeoutMs = TIMEOUT_MS } = {}) {
  const config = getShipwayConfig();
  const authorization = Buffer.from(`${config.email}:${config.licenseKey}`, "utf8").toString("base64");
  const url = new URL(GET_ORDERS_ENDPOINT);
  url.searchParams.set("orderid", orderNumber);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { headers: { Authorization: `Basic ${authorization}`, Accept: "application/json" }, signal: controller.signal });
  } catch (cause) {
    const error = new Error("Shipway lookup could not be completed, so no booking was attempted.");
    error.code = "SHIPWAY_RECONCILIATION_FAILED";
    error.cause = cause;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => null);
  if (response.status === 404) return { state: "confirmed_absent", body, httpStatus: response.status };
  if (!response.ok) {
    const error = new Error(messageOf(body, `Shipway lookup returned HTTP ${response.status}`));
    error.code = "SHIPWAY_RECONCILIATION_FAILED";
    error.status = response.status;
    error.upstreamBody = body;
    shipwayDiagnostics({ orderNumber, httpStatus: response.status, body, error, operation: "reconciliation_http_error" });
    throw error;
  }
  const awb = valueOf(body, ["AWB", "awb", "awb_number", "tracking_number"]);
  const labelUrl = valueOf(body, ["shipping_url", "label_url", "shipping_label_url"]);
  const carrierId = valueOf(body, ["carrier_id", "carrier"]);
  const carrierName = valueOf(body, ["carrier_name", "courier_name"]);
  const returnedOrderId = valueOf(body, ["order_id", "orderid"]);
  // getorders answers HTTP 200 {"success":1,"message":"No order found"} for an unknown orderid.
  if (!awb && !labelUrl && typeof body?.message === "string" && NO_ORDER_PATTERN.test(body.message.trim())) {
    return { state: "confirmed_absent", body, httpStatus: response.status };
  }
  if (awb || labelUrl || returnedOrderId === orderNumber) return { state: "exists", body, httpStatus: response.status, awb, labelUrl, carrierId, carrierName };
  // Shipway's documented GET endpoint returns an empty order collection when an exact orderid has no match.
  const empty = Array.isArray(body) ? body.length === 0 : Array.isArray(body?.orders) ? body.orders.length === 0 : Array.isArray(body?.data) ? body.data.length === 0 : false;
  if (empty) return { state: "confirmed_absent", body, httpStatus: response.status };
  const error = new Error("Shipway lookup returned an unrecognised response; booking remains locked to prevent a duplicate.");
  error.code = "SHIPWAY_RECONCILIATION_FAILED";
  error.upstreamBody = body;
  shipwayDiagnostics({ orderNumber, httpStatus: response.status, body, error, operation: "reconciliation_ambiguous" });
  throw error;
}

/* ---------------------------------------------------------------------------
 * Read-only tracking. Uses GET getorders only; it never books, modifies, or
 * cancels a Shipway order and never calls v2orders.
 * ------------------------------------------------------------------------- */

export const SHIPWAY_STATUS_MAP = Object.freeze({
  SCH: { label: "Shipment Booked", fulfillmentStatus: "shipment_created" },
  INT: { label: "In Transit", fulfillmentStatus: "in_transit" },
  OOD: { label: "Out for Delivery", fulfillmentStatus: "out_for_delivery" },
  DEL: { label: "Delivered", fulfillmentStatus: "delivered" },
  UND: { label: "Undelivered", fulfillmentStatus: "ndr" },
  RTO: { label: "Return to Origin", fulfillmentStatus: "rto" },
  RTD: { label: "Returned", fulfillmentStatus: "returned" },
  CAN: { label: "Cancelled", fulfillmentStatus: "cancelled" },
  // No fulfillment equivalent: the label is recorded, fulfillment is left unchanged.
  ONH: { label: "On Hold", fulfillmentStatus: null },
});

const LABEL_TO_CODE = new Map(Object.entries(SHIPWAY_STATUS_MAP).map(([code, item]) => [item.label.toLowerCase(), code]));

/** Known codes map to a label + fulfillment status; unknown codes are preserved as-is and never guessed. */
export function mapShipwayStatus(code, statusText = null) {
  const raw = String(code ?? "").trim().toUpperCase();
  const label = String(statusText ?? "").trim();
  const labelCode = raw ? null : LABEL_TO_CODE.get(label.toLowerCase()) || null;
  const known = SHIPWAY_STATUS_MAP[raw] || (labelCode && SHIPWAY_STATUS_MAP[labelCode]);
  if (known) return { code: raw || labelCode, label: known.label, fulfillmentStatus: known.fulfillmentStatus, known: true };
  return { code: raw || null, label: label || raw || null, fulfillmentStatus: null, known: false };
}

const SENSITIVE_TRACKING_KEY = /email|phone|mobile|address|authorization|license|password|customer|consignee|first_?name|last_?name|full_?name|billing|zip_?code|pin_?code|^name$/i;

/** Strip personal data before a Shipway body is stored or logged. */
export function redactShipwayTrackingBody(value, depth = 0) {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.map((item) => redactShipwayTrackingBody(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_TRACKING_KEY.test(key) ? "[redacted]" : redactShipwayTrackingBody(item, depth + 1)]));
  }
  return value;
}

const textOf = (value, max = 255) => {
  if (value == null || typeof value === "object") return null;
  const result = String(value).replace(/\s+/g, " ").trim();
  return result ? result.slice(0, max) : null;
};
const firstText = (source, keys, max) => {
  for (const key of keys) {
    const found = textOf(source?.[key], max);
    if (found) return found;
  }
  return null;
};
const pad = (n) => String(n).padStart(2, "0");

/**
 * Normalise a Shipway timestamp to "YYYY-MM-DD HH:MM:SS". Zone-less wall-clock
 * values are kept as sent (no timezone shift); unparseable values become null.
 */
export function normalizeShipwayTime(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace("T", " ");
  }
  const raw = String(value).trim();
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) return `${match[1]}-${match[2]}-${match[3]} ${match[4] || "00"}:${match[5] || "00"}:${match[6] || "00"}`;
  match = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]} ${match[4] || "00"}:${match[5] || "00"}:${match[6] || "00"}`;
  if (/^\d{10,13}$/.test(raw)) return normalizeShipwayTime(Number(raw));
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

const CODE_LIKE = /^[A-Z][A-Z0-9_]{1,7}$/;
// Shipway sends "O", "0" (or another single character / bare number / null
// marker) when it has no readable status for an AWB yet. That is not a stage,
// so it is ignored and the latest scan event (if any) decides the status.
const PLACEHOLDER_STATUS = /^(\d+|[a-z]|null|undefined|none|-+|n\/?a)$/i;
export function isShipwayPlaceholderStatus(value) {
  return PLACEHOLDER_STATUS.test(String(value ?? "").trim());
}
const statusTextOf = (source, keys, max) => {
  const value = firstText(source, keys, max);
  return value && !PLACEHOLDER_STATUS.test(value) ? value : null;
};
const codeOf = (source, keys) => {
  for (const key of keys) {
    const value = textOf(source?.[key], 60);
    if (value && CODE_LIKE.test(value)) return value;
  }
  return null;
};
const EVENT_LIST_KEYS = ["shipment_status_scan", "scans", "scan", "scan_details", "tracking_history", "track_history", "history", "events", "track_activities", "shipment_track_activities", "shipment_track", "tracking"];
const NESTED_KEYS = ["shipment_details", "shipment", "tracking_details", "tracking_data", "awb_details"];
const EVENT_TIME_KEYS = ["datetime", "date_time", "event_time", "scan_time", "scan_datetime", "status_time", "timestamp", "updated_at", "date"];

function parseShipwayEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const statusCode = codeOf(raw, ["status_code", "code", "shipment_status", "status"]);
  const rawText = statusTextOf(raw, ["status_name", "status_label", "status", "shipment_status_name", "scan_status"], 160);
  const statusText = rawText && rawText !== statusCode ? rawText : null;
  const mapped = mapShipwayStatus(statusCode, statusText);
  let eventTime = null;
  for (const key of EVENT_TIME_KEYS) if ((eventTime = normalizeShipwayTime(raw[key]))) break;
  const time = eventTime && eventTime.endsWith("00:00:00") && String(raw.time ?? "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (time) eventTime = `${eventTime.slice(0, 10)} ${pad(time[1])}:${time[2]}:${time[3] || "00"}`;
  const location = firstText(raw, ["location", "scan_location", "city", "place", "current_location"], 255);
  const activity = firstText(raw, ["activity", "remark", "remarks", "message", "description", "instructions", "details"], 2000);
  const status = statusText || mapped.label || activity;
  if (!status) return null;
  return {
    status: status.slice(0, 160),
    statusCode: mapped.code,
    fulfillmentStatus: mapped.fulfillmentStatus,
    eventTime,
    location,
    activity,
    raw: redactShipwayTrackingBody(raw),
  };
}

/** Defensive parser for one getorders order record. Never throws; missing fields become null. */
export function parseShipwayTrackingRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  let record = { ...input };
  for (const key of NESTED_KEYS) {
    if (input[key] && typeof input[key] === "object" && !Array.isArray(input[key])) record = { ...input[key], ...record };
  }
  const statusCode = codeOf(record, ["shipment_status", "shipment_status_code", "current_status_code", "status_code", "current_status", "status"]);
  const rawText = statusTextOf(record, ["shipment_status_name", "current_status", "status_name", "shipment_status_text", "status_description", "status"], 160);
  const statusText = rawText && rawText !== statusCode ? rawText : null;
  const mapped = mapShipwayStatus(statusCode, statusText);
  let eventsRaw = [];
  for (const key of EVENT_LIST_KEYS) if (Array.isArray(record[key])) { eventsRaw = record[key]; break; }
  const events = eventsRaw.map(parseShipwayEvent).filter(Boolean)
    .sort((a, b) => (a.eventTime || "").localeCompare(b.eventTime || ""));
  const latestEvent = events.at(-1) || null;
  let statusAt = null;
  for (const key of ["shipment_status_time", "status_time", "status_date", "last_status_time", "status_updated_at", "last_update", "updated_at"]) {
    if ((statusAt = normalizeShipwayTime(record[key]))) break;
  }
  const fromEvent = !mapped.code && !mapped.label && latestEvent;
  const carrierRaw = textOf(record.carrier ?? record.courier, 80);
  const carrierIsId = carrierRaw != null && /^\d+$/.test(carrierRaw);
  return {
    orderId: firstText(record, ["order_id", "orderid", "order_number"], 160),
    awb: firstText(record, ["awb", "AWB", "awbno", "awb_no", "awb_number", "awb_code", "tracking_number", "order_tracking_number"], 40),
    carrierId: firstText(record, ["carrier_id", "courier_id"], 80) || (carrierIsId ? carrierRaw : null),
    carrierName: firstText(record, ["carrier_title", "carrier_name", "courier_name", "courier_title"], 80) || (carrierIsId ? null : carrierRaw),
    statusCode: fromEvent ? latestEvent.statusCode : mapped.code,
    statusLabel: fromEvent ? latestEvent.status : mapped.label,
    fulfillmentStatus: fromEvent ? latestEvent.fulfillmentStatus : mapped.fulfillmentStatus,
    statusAt: statusAt || latestEvent?.eventTime || null,
    location: firstText(record, ["current_location", "location", "last_location"], 255) || latestEvent?.location || null,
    activity: latestEvent?.activity || null,
    expectedDeliveryDate: normalizeShipwayTime(record.expected_delivery_date ?? record.edd ?? record.etd)?.slice(0, 10) || null,
    events,
  };
}

function orderRecordsOf(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  for (const key of ["message", "orders", "data", "result", "response"]) {
    const value = body[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      if (Array.isArray(value.orders)) return value.orders;
      if (Array.isArray(value.data)) return value.data;
      return [value];
    }
  }
  return null;
}

function trackingError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

const sameId = (a, b) => a != null && b != null && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Parse a getorders body for one order/AWB.
 * Returns { state: "found", tracking } | { state: "not_found" }; throws SHIPWAY_TRACKING_* errors.
 */
export function parseShipwayTrackingResponse(body, { orderNumber = null, awb = null } = {}) {
  if (body == null || (isPlainObject(body) && !Object.keys(body).length)) {
    throw trackingError("SHIPWAY_TRACKING_INVALID_RESPONSE", "Shipway returned an empty tracking response.", { retryable: true });
  }
  if (isPlainObject(body) && typeof body.message === "string" && NO_ORDER_PATTERN.test(body.message.trim())) return { state: "not_found" };
  if (isPlainObject(body) && [0, "0", false].includes(body.success)) {
    const message = messageOf(body, "Shipway rejected the tracking request.");
    if (/auth|credential|licen[sc]e|unauthori[sz]ed|forbidden|permission/i.test(message)) {
      throw trackingError("SHIPWAY_TRACKING_AUTH", "Shipway rejected the tracking credentials.", { retryable: false, stopBatch: true });
    }
    throw trackingError("SHIPWAY_TRACKING_INVALID_RESPONSE", `Shipway tracking was not successful: ${message}`, { retryable: true });
  }
  const records = orderRecordsOf(body);
  if (!records) throw trackingError("SHIPWAY_TRACKING_INVALID_RESPONSE", "Shipway returned an unrecognised tracking response.", { retryable: true });
  if (!records.length) return { state: "not_found" };
  const parsed = records.map(parseShipwayTrackingRecord).filter(Boolean);
  if (!parsed.length) throw trackingError("SHIPWAY_TRACKING_INVALID_RESPONSE", "Shipway returned an unrecognised tracking response.", { retryable: true });
  const tracking = parsed.find((item) => (orderNumber && sameId(item.orderId, orderNumber)) || (awb && sameId(item.awb, awb)))
    // A single record with no identifiers at all cannot be attributed to another order.
    || (parsed.length === 1 && !parsed[0].orderId && !parsed[0].awb ? parsed[0] : null);
  if (!tracking) return { state: "not_found" };
  if (!tracking.statusCode && !tracking.statusLabel && !tracking.events.length) {
    throw trackingError("SHIPWAY_TRACKING_INVALID_RESPONSE", "Shipway returned no tracking status or events for this order.", { retryable: true });
  }
  return { state: "found", tracking };
}

/** Log-safe summary of a tracking failure: never URLs, headers, bodies, or customer data. */
export function safeShipwayTrackingError(error) {
  return { code: error?.code || null, httpStatus: error?.httpStatus ?? null, retryable: error?.retryable ?? null };
}

/**
 * Read-only Shipway tracking lookup by order number and/or AWB (GET getorders).
 * Throws SHIPWAY_TRACKING_* errors carrying httpStatus / retryable / stopBatch.
 */
export async function getShipwayTracking({ orderNumber = null, awb = null } = {}, { timeoutMs = TIMEOUT_MS } = {}) {
  const order = textOf(orderNumber, 160);
  const waybill = textOf(awb, 40);
  if (!order && !waybill) throw trackingError("SHIPWAY_TRACKING_NO_IDENTIFIER", "An order number or AWB is required for Shipway tracking.", { retryable: false });
  let config;
  try {
    config = getShipwayConfig();
  } catch (error) {
    throw trackingError("SHIPWAY_CONFIG_ERROR", error.message, { retryable: false, stopBatch: true });
  }
  const authorization = Buffer.from(`${config.email}:${config.licenseKey}`, "utf8").toString("base64");
  const url = new URL(GET_ORDERS_ENDPOINT);
  // Documented getorders lookup parameters: orderid and awb_number.
  if (order) url.searchParams.set("orderid", order);
  else url.searchParams.set("awb_number", waybill);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let raw;
  try {
    response = await fetch(url, { method: "GET", headers: { Authorization: `Basic ${authorization}`, Accept: "application/json" }, signal: controller.signal });
    raw = await response.text();
  } catch (cause) {
    if (cause?.name === "AbortError") throw trackingError("SHIPWAY_TRACKING_TIMEOUT", "Shipway tracking request timed out.", { retryable: true });
    throw trackingError("SHIPWAY_TRACKING_NETWORK", "Shipway tracking is currently unreachable.", { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  const status = response.status;
  if (status === 401 || status === 403) throw trackingError("SHIPWAY_TRACKING_AUTH", `Shipway tracking returned HTTP ${status}.`, { httpStatus: status, retryable: false, stopBatch: true });
  if (status === 404) return { state: "not_found", httpStatus: status };
  if (status === 429) throw trackingError("SHIPWAY_TRACKING_RATE_LIMITED", "Shipway tracking is rate limited; retry later.", { httpStatus: status, retryable: true, stopBatch: true });
  if (!response.ok) throw trackingError("SHIPWAY_TRACKING_UPSTREAM", `Shipway tracking returned HTTP ${status}.`, { httpStatus: status, retryable: status >= 500 });
  let body;
  try {
    body = String(raw ?? "").trim() ? JSON.parse(raw) : null;
  } catch {
    throw trackingError("SHIPWAY_TRACKING_INVALID_RESPONSE", "Shipway returned malformed tracking JSON.", { httpStatus: status, retryable: true });
  }
  const parsed = parseShipwayTrackingResponse(body, { orderNumber: order, awb: waybill });
  return { ...parsed, httpStatus: status, body: redactShipwayTrackingBody(body) };
}
