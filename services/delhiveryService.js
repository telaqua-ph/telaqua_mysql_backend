/**
 * services/delhiveryService.js
 *
 * Delhivery B2C logistics (staging + production via DELHIVERY_ENV):
 * serviceability, TAT, waybill, rate, warehouse, shipment create/update,
 * tracking, label, pickup, NDR.
 *
 * Token and URLs from process.env only — never hardcoded or fully logged.
 */

function getDelhiveryApiToken() {
  const raw = process.env.DELHIVERY_API_TOKEN;
  if (raw == null) return "";
  let token = String(raw).trim();
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  return token;
}

function getDelhiveryEnv() {
  const env = (process.env.DELHIVERY_ENV || "").trim().toLowerCase();
  if (env !== "staging" && env !== "production") {
    const err = new Error(
      'DELHIVERY_ENV must be either "staging" or "production"'
    );
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }
  return env;
}

function requireEnvUrl(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    const err = new Error(`${name} is not configured`);
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }
  return value;
}

/** Central resolver: DELHIVERY_ENV → STAGING/PRODUCTION URL. */
function resolveDelhiveryUrl(operationKey) {
  const env = getDelhiveryEnv();
  const prefix = env === "staging" ? "DELHIVERY_STAGING_" : "DELHIVERY_PRODUCTION_";
  const name = `${prefix}${operationKey}`;
  return { env, baseUrl: requireEnvUrl(name), urlName: name };
}

function getPincodeUrlTemplate() {
  const { env, baseUrl } = resolveDelhiveryUrl("PINCODE_URL");
  return { env, urlTemplate: baseUrl };
}
function getTatBaseUrl() {
  return resolveDelhiveryUrl("TAT_URL");
}
function getWaybillBaseUrl() {
  return resolveDelhiveryUrl("WAYBILL_URL");
}
function getRateBaseUrl() {
  return resolveDelhiveryUrl("RATE_URL");
}
function getWarehouseCreateBaseUrl() {
  return resolveDelhiveryUrl("WAREHOUSE_CREATE_URL");
}
function getShipmentCreateBaseUrl() {
  return resolveDelhiveryUrl("SHIPMENT_CREATE_URL");
}
function getShipmentUpdateBaseUrl() {
  return resolveDelhiveryUrl("SHIPMENT_UPDATE_URL");
}
function getTrackingBaseUrl() {
  return resolveDelhiveryUrl("TRACKING_URL");
}
function getLabelBaseUrl() {
  return resolveDelhiveryUrl("LABEL_URL");
}
function getPickupBaseUrl() {
  return resolveDelhiveryUrl("PICKUP_URL");
}
function getNdrBaseUrl() {
  return resolveDelhiveryUrl("NDR_URL");
}

function buildPincodeServiceabilityUrl(urlTemplate, pincode) {
  const normalized = String(urlTemplate).replaceAll("pin_code", String(pincode));
  const url = new URL(normalized);
  url.searchParams.set("filter_codes", String(pincode));
  return url.toString();
}

function buildExpectedTatUrl(baseUrl, params) {
  const url = new URL(baseUrl);
  url.searchParams.set("origin_pin", params.origin_pin);
  url.searchParams.set("destination_pin", params.destination_pin);
  url.searchParams.set("mot", params.mot);
  return url.toString();
}

function logDelhiveryRequest(requestUrl, token, debugMeta = {}) {
  try {
    const debugUrl = new URL(requestUrl);
    console.log("Delhivery request:", {
      ...debugMeta,
      tokenPresent: Boolean(token),
      host: debugUrl.host,
      path: debugUrl.pathname,
      query: Object.fromEntries(debugUrl.searchParams.entries()),
      authScheme: "Token",
    });
  } catch {
    /* ignore */
  }
}

async function parseDelhiveryJson(response) {
  const text = await response.text();
  if (!text || !String(text).trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractUpstreamMessage(body) {
  if (!body || typeof body !== "object") return null;
  const candidates = [body.message, body.msg, body.error, body.detail];
  if (body.data && typeof body.data === "object") {
    candidates.push(body.data.message, body.data.msg, body.data.error);
  }
  if (typeof body.rmk === "string") candidates.push(body.rmk);
  if (Array.isArray(body.packages)) {
    for (const pkg of body.packages) {
      if (pkg?.remarks) candidates.push(pkg.remarks);
      if (pkg?.remark) candidates.push(pkg.remark);
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (Array.isArray(candidate) && candidate.length) {
      const joined = candidate.filter((x) => typeof x === "string").join("; ");
      if (joined) return joined;
    }
  }
  return null;
}

function throwUpstreamError(response, debugMeta, body) {
  console.error("Delhivery upstream error:", {
    status: response.status,
    statusText: response.statusText,
    api: debugMeta.api || "unknown",
  });
  const upstreamMessage = extractUpstreamMessage(body);
  const err = new Error(
    upstreamMessage || `Delhivery API returned HTTP ${response.status}`
  );
  err.code = "DELHIVERY_UPSTREAM_ERROR";
  err.status = response.status;
  err.upstreamBody = body;
  throw err;
}

function wrapNetworkError(networkError) {
  if (
    networkError?.name === "TimeoutError" ||
    networkError?.name === "AbortError"
  ) {
    const err = new Error("Delhivery request timed out");
    err.code = "DELHIVERY_TIMEOUT";
    err.cause = networkError;
    throw err;
  }
  const err = new Error("Delhivery service is currently unavailable");
  err.code = "DELHIVERY_NETWORK_ERROR";
  err.cause = networkError;
  throw err;
}

async function delhiveryGet(requestUrl, token, debugMeta = {}) {
  logDelhiveryRequest(requestUrl, token, { ...debugMeta, method: "GET" });
  let response;
  try {
    response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        Authorization: `Token ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(45000),
    });
  } catch (networkError) {
    wrapNetworkError(networkError);
  }
  const body = await parseDelhiveryJson(response);
  if (!response.ok) throwUpstreamError(response, debugMeta, body);
  if (body === null) {
    const err = new Error("Delhivery returned an invalid or unexpected response");
    err.code = "DELHIVERY_INVALID_RESPONSE";
    throw err;
  }
  return body;
}

async function delhiveryPost(requestUrl, token, payload, debugMeta = {}) {
  logDelhiveryRequest(requestUrl, token, { ...debugMeta, method: "POST" });
  let response;
  try {
    response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Token ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000),
    });
  } catch (networkError) {
    wrapNetworkError(networkError);
  }
  const body = await parseDelhiveryJson(response);
  if (!response.ok) throwUpstreamError(response, debugMeta, body);
  if (body === null) {
    const err = new Error("Delhivery returned an invalid or unexpected response");
    err.code = "DELHIVERY_INVALID_RESPONSE";
    throw err;
  }
  return body;
}

async function delhiveryPostForm(requestUrl, token, formFields, debugMeta = {}) {
  logDelhiveryRequest(requestUrl, token, {
    ...debugMeta,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
  });
  let response;
  try {
    response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Token ${token}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(formFields).toString(),
      signal: AbortSignal.timeout(45000),
    });
  } catch (networkError) {
    wrapNetworkError(networkError);
  }
  const body = await parseDelhiveryJson(response);
  if (!response.ok) throwUpstreamError(response, debugMeta, body);
  if (body === null) {
    const err = new Error("Delhivery returned an invalid or unexpected response");
    err.code = "DELHIVERY_INVALID_RESPONSE";
    throw err;
  }
  return body;
}

function requireToken() {
  const token = getDelhiveryApiToken();
  if (!token) {
    const err = new Error("DELHIVERY_API_TOKEN is not configured");
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }
  return token;
}

export async function checkPincodeServiceability(pincode) {
  const token = requireToken();
  const { env, urlTemplate } = getPincodeUrlTemplate();
  return delhiveryGet(
    buildPincodeServiceabilityUrl(urlTemplate, pincode),
    token,
    { api: "pincode_serviceability", env }
  );
}

export async function getExpectedTat(params) {
  const token = requireToken();
  const { env, baseUrl } = getTatBaseUrl();
  return delhiveryGet(buildExpectedTatUrl(baseUrl, params), token, {
    api: "expected_tat",
    env,
  });
}

export async function getWaybills(count) {
  const token = requireToken();
  const { env, baseUrl } = getWaybillBaseUrl();
  const url = new URL(baseUrl);
  url.searchParams.set("count", String(count));
  return delhiveryGet(url.toString(), token, { api: "waybill_bulk", env });
}

export async function getShippingRate(params) {
  const token = requireToken();
  const { env, baseUrl } = getRateBaseUrl();
  const url = new URL(baseUrl);
  url.searchParams.set("md", params.md);
  url.searchParams.set("cgm", String(params.cgm));
  url.searchParams.set("o_pin", params.o_pin);
  url.searchParams.set("d_pin", params.d_pin);
  url.searchParams.set("ss", params.ss);
  return delhiveryGet(url.toString(), token, { api: "rate_calculator", env });
}

export async function createClientWarehouse(payload) {
  const token = requireToken();
  const { env, baseUrl } = getWarehouseCreateBaseUrl();
  return delhiveryPost(baseUrl, token, payload, {
    api: "client_warehouse_create",
    env,
  });
}

export async function createShipment(payload) {
  const token = requireToken();
  const { env, baseUrl } = getShipmentCreateBaseUrl();
  console.log(`Delhivery shipment environment: ${env}`);
  return delhiveryPostForm(
    baseUrl,
    token,
    { format: "json", data: JSON.stringify(payload) },
    { api: "shipment_create", env }
  );
}

export async function updateShipment(payload) {
  const token = requireToken();
  const { env, baseUrl } = getShipmentUpdateBaseUrl();
  console.log(`Delhivery shipment update environment: ${env}`);
  return delhiveryPost(baseUrl, token, payload, {
    api: "shipment_update",
    env,
  });
}

export async function trackShipment(waybill) {
  const token = requireToken();
  const { env, baseUrl } = getTrackingBaseUrl();
  console.log(`Delhivery tracking environment: ${env}`);
  const url = new URL(baseUrl);
  url.searchParams.set("waybill", String(waybill));
  return delhiveryGet(url.toString(), token, {
    api: "shipment_tracking",
    env,
  });
}

export async function generateShippingLabel(waybill) {
  const token = requireToken();
  const { env, baseUrl } = getLabelBaseUrl();
  console.log(`Delhivery label environment: ${env}`);
  const url = new URL(baseUrl);
  url.searchParams.set("wbns", String(waybill));
  return delhiveryGet(url.toString(), token, {
    api: "packing_slip_label",
    env,
  });
}

export async function requestPickup(payload) {
  const token = requireToken();
  const { env, baseUrl } = getPickupBaseUrl();
  console.log(`Delhivery pickup environment: ${env}`);
  return delhiveryPost(baseUrl, token, payload, {
    api: "pickup_request",
    env,
  });
}

export async function updateNdr(payload) {
  const token = requireToken();
  const { env, baseUrl } = getNdrBaseUrl();
  console.log(`Delhivery NDR environment: ${env}`);
  return delhiveryPost(baseUrl, token, payload, { api: "ndr_update", env });
}
