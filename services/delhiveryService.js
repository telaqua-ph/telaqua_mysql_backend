/**
 * services/delhiveryService.js
 *
 * Delhivery B2C — shipment creation only (CMU create.json).
 * Token and URLs come from process.env — never hardcoded or fully logged.
 *
 * Tel-Aqua does NOT implement pickup request, label, or tracking APIs.
 * After create, operators continue in Delhivery One. See docs/DELHIVERY_FLOW.md
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

function getShipmentCreateBaseUrl() {
  const env = getDelhiveryEnv();

  if (env === "staging") {
    return {
      env,
      baseUrl: requireEnvUrl("DELHIVERY_STAGING_SHIPMENT_CREATE_URL"),
    };
  }

  return {
    env,
    baseUrl: requireEnvUrl("DELHIVERY_PRODUCTION_SHIPMENT_CREATE_URL"),
  };
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
    // ignore debug URL parse failures
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

  if (typeof body.rmk === "string") {
    candidates.push(body.rmk);
  }
  if (Array.isArray(body.packages)) {
    for (const pkg of body.packages) {
      if (pkg && typeof pkg.remarks === "string") candidates.push(pkg.remarks);
      if (pkg && typeof pkg.remark === "string") candidates.push(pkg.remark);
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (Array.isArray(candidate) && candidate.length > 0) {
      const joined = candidate
        .map((item) => (typeof item === "string" ? item : null))
        .filter(Boolean)
        .join("; ");
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

/**
 * Perform a Delhivery POST with application/x-www-form-urlencoded body.
 * Used by CMU create.json which requires format=json&data=<payload>.
 */
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

  const body = await parseDelhiveryJson(response);

  if (!response.ok) {
    throwUpstreamError(response, debugMeta, body);
  }

  if (body === null) {
    const err = new Error(
      "Delhivery returned an invalid or unexpected response"
    );
    err.code = "DELHIVERY_INVALID_RESPONSE";
    throw err;
  }

  return body;
}

/**
 * Create / manifest a Delhivery shipment (CMU create.json).
 * Body must be sent as format=json&data=<JSON> per Delhivery docs.
 * @param {{ pickup_location: object, shipments: object[] }} payload
 * @returns {Promise<any>}
 */
export async function createShipment(payload) {
  const token = getDelhiveryApiToken();

  if (!token) {
    const err = new Error("DELHIVERY_API_TOKEN is not configured");
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  const { env, baseUrl } = getShipmentCreateBaseUrl();
  console.log(`Delhivery shipment environment: ${env}`);

  return delhiveryPostForm(
    baseUrl,
    token,
    {
      format: "json",
      data: JSON.stringify(payload),
    },
    {
      api: "shipment_create",
      env,
    }
  );
}
