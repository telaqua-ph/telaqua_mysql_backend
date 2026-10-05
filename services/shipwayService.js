import { getShipwayConfig } from "../config/shipwayConfig.js";

const ENDPOINT = "https://app.shipway.com/api/v2orders";
const GET_ORDERS_ENDPOINT = "https://app.shipway.com/api/getorders";
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
  if (isShipwayNoCourierResponse(body)) {
    const courierText = typeof body?.awb_response === "string" ? messageOf({ message: body.awb_response }, "") : "";
    safeMessage = [safeMessage, courierText && courierText !== safeMessage ? courierText : ""].filter(Boolean).join(" ") +
      ` The Shipway account has no active courier: ${NO_COURIER_GUIDANCE}, then retry.`;
  }
  shipwayDiagnostics({ ...context, body, error: { message: safeMessage }, operation: "booking_response" });
  const error = new Error(`Shipway: ${safeMessage}`);
  error.code = "SHIPWAY_PARTIAL_OR_REJECTED";
  error.upstreamBody = body || null;
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
      hasCarrierId: Object.hasOwn(payload, 'carrier_id'),
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

/** Read-only reconciliation. It never creates, modifies, or cancels a Shipway order. */
export async function findShipwayOrder(orderNumber) {
  const config = getShipwayConfig();
  const authorization = Buffer.from(`${config.email}:${config.licenseKey}`, "utf8").toString("base64");
  const url = new URL(GET_ORDERS_ENDPOINT);
  url.searchParams.set("orderid", orderNumber);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
