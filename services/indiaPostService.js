/**
 * India Post (Department of Posts, CEPT) customer-integration API.
 *
 * Docs: https://app.indiapost.gov.in/developer-portal/apidoc
 *   POST {base}/v1/access/login                      -> access_token (Bearer, ~15 min)
 *   POST {base}/process-articles-file/{customId}     -> bulk booking (JSON { articles: [...] })
 *   GET  {base}/v1/tracking/{trackingNumber}         -> currentStatus + history
 *
 * .env (Hostinger)
 *   INDIA_POST_ENV=sandbox                       (sandbox | production)
 *   INDIA_POST_BASE_URL=https://test.cept.gov.in/beextcustomer
 *   INDIA_POST_USERNAME / INDIA_POST_PASSWORD     (developer portal login)
 *   INDIA_POST_CUSTOMER_ID                        (path id for booking)
 *   INDIA_POST_BULK_CUSTOMER_ID                   (defaults to INDIA_POST_CUSTOMER_ID)
 *   INDIA_POST_CONTRACT_ID                        (from your India Post business contract)
 *   INDIA_POST_DROPOFF_OFFICE_ID / INDIA_POST_DROPOFF_PINCODE   (post office where parcels are handed over)
 *   INDIA_POST_PICKUP_OR_DROPOFF=DROPOFF          (DROPOFF | PICKUP)
 *   INDIA_POST_ARTICLE_TYPE=SP                    (SP = Speed Post, BP = Business Parcel)
 *   INDIA_POST_WEIGHT_GRAMS=300  INDIA_POST_LENGTH_CM=20  INDIA_POST_BREADTH_CM=10  INDIA_POST_HEIGHT_CM=6
 *   Sender: INDIA_POST_SENDER_* or the existing TELAQUA_WAREHOUSE_* values.
 */

const DEFAULT_SANDBOX_BASE = "https://test.cept.gov.in/beextcustomer";
const REQUEST_TIMEOUT_MS = 20_000;
export const INDIA_POST_PROVIDER = "IndiaPost";
export const INDIA_POST_COURIER_NAME = "India Post Speed Post";

let fetchImpl = (...args) => fetch(...args);
let cachedToken = null; // { token, expiresAt }

/** Test seam. */
export function setIndiaPostFetchForTests(fn) {
  fetchImpl = fn || ((...args) => fetch(...args));
  cachedToken = null;
}

const text = (v) => String(v ?? "").trim();
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function isIndiaPostShipment(shipment) {
  return text(shipment?.provider).toLowerCase().replace(/[\s_-]/g, "") === "indiapost";
}

export function getIndiaPostConfig(env = process.env) {
  const customerId = text(env.INDIA_POST_CUSTOMER_ID);
  return {
    environment: text(env.INDIA_POST_ENV).toLowerCase() === "production" ? "production" : "sandbox",
    baseUrl: (text(env.INDIA_POST_BASE_URL) || DEFAULT_SANDBOX_BASE).replace(/\/+$/, ""),
    username: text(env.INDIA_POST_USERNAME),
    password: String(env.INDIA_POST_PASSWORD ?? ""),
    customerId,
    bulkCustomerId: text(env.INDIA_POST_BULK_CUSTOMER_ID) || customerId,
    contractId: text(env.INDIA_POST_CONTRACT_ID),
    dropoffOfficeId: text(env.INDIA_POST_DROPOFF_OFFICE_ID),
    pickupOrDropoff: text(env.INDIA_POST_PICKUP_OR_DROPOFF).toUpperCase() === "PICKUP" ? "PICKUP" : "DROPOFF",
    articleType: text(env.INDIA_POST_ARTICLE_TYPE).toUpperCase() === "BP" ? "BP" : "SP",
    weightGrams: num(env.INDIA_POST_WEIGHT_GRAMS, 300),
    lengthCm: num(env.INDIA_POST_LENGTH_CM, 20),
    breadthCm: num(env.INDIA_POST_BREADTH_CM, 10),
    heightCm: num(env.INDIA_POST_HEIGHT_CM, 6),
    sender: {
      name: text(env.INDIA_POST_SENDER_NAME) || text(env.TELAQUA_WAREHOUSE_NAME) || text(env.TELAQUA_BUSINESS_NAME) || "Tel-Aqua",
      company: text(env.INDIA_POST_SENDER_COMPANY) || "AQUA AI PRIVATE LIMITED",
      address: text(env.INDIA_POST_SENDER_ADDRESS) || text(env.TELAQUA_WAREHOUSE_ADDRESS),
      city: text(env.INDIA_POST_SENDER_CITY) || text(env.TELAQUA_WAREHOUSE_CITY),
      state: text(env.INDIA_POST_SENDER_STATE) || text(env.TELAQUA_WAREHOUSE_STATE),
      pincode: text(env.INDIA_POST_SENDER_PINCODE) || text(env.TELAQUA_WAREHOUSE_PINCODE),
      mobile: (text(env.INDIA_POST_SENDER_MOBILE) || text(env.TELAQUA_WAREHOUSE_PHONE)).replace(/\D/g, "").slice(-10),
      email: text(env.INDIA_POST_SENDER_EMAIL),
    },
    dropoffPincode: text(env.INDIA_POST_DROPOFF_PINCODE) || text(env.INDIA_POST_SENDER_PINCODE) || text(env.TELAQUA_WAREHOUSE_PINCODE),
  };
}

/** Settings still missing for API booking (login, tracking only need the first three). */
export function missingIndiaPostSettings(config = getIndiaPostConfig(), { forBooking = false } = {}) {
  const missing = [];
  if (!config.username) missing.push("INDIA_POST_USERNAME");
  if (!config.password) missing.push("INDIA_POST_PASSWORD");
  if (!forBooking) return missing;
  if (!config.customerId) missing.push("INDIA_POST_CUSTOMER_ID");
  if (!/^\d+$/.test(config.bulkCustomerId)) missing.push("INDIA_POST_BULK_CUSTOMER_ID (numeric)");
  if (!/^\d+$/.test(config.contractId)) missing.push("INDIA_POST_CONTRACT_ID (numeric)");
  if (!config.sender.address) missing.push("INDIA_POST_SENDER_ADDRESS");
  if (!config.sender.city) missing.push("INDIA_POST_SENDER_CITY");
  if (!/^\d{6}$/.test(config.sender.pincode)) missing.push("INDIA_POST_SENDER_PINCODE");
  if (!/^\d{10}$/.test(config.sender.mobile)) missing.push("INDIA_POST_SENDER_MOBILE");
  if (!/^\d{6}$/.test(config.dropoffPincode)) missing.push("INDIA_POST_DROPOFF_PINCODE");
  return missing;
}

function indiaPostError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

async function callIndiaPost(url, { method = "GET", headers = {}, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw indiaPostError("INDIA_POST_TIMEOUT", `India Post did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds (${new URL(url).host}). Usually the server IP is not whitelisted yet, or India Post's test server is down.`);
    }
    // Node fetch puts the real network reason in error.cause (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, certificate errors...).
    const cause = error?.cause || {};
    const reason = [cause.code, cause.message || error?.message].filter(Boolean).join(": ").slice(0, 200);
    throw indiaPostError(
      "INDIA_POST_NETWORK_ERROR",
      `India Post could not be reached (${new URL(url).host}${reason ? ` - ${reason}` : ""}). If this keeps happening, check that the server IP is whitelisted on the India Post developer portal.`,
      { networkCause: cause.code || null }
    );
  } finally {
    clearTimeout(timer);
  }
  const raw = await response.text().catch(() => "");
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 500) }; }
  return { status: response.status, ok: response.ok, data };
}

const upstreamMessage = (data, fallback) =>
  text(data?.message || data?.error || data?.detail || data?.errors?.[0] || fallback).slice(0, 300);

/** Bearer token, cached until shortly before it expires. */
export async function getIndiaPostToken({ config = getIndiaPostConfig(), force = false } = {}) {
  if (!force && cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token;
  const missing = missingIndiaPostSettings(config);
  if (missing.length) throw indiaPostError("INDIA_POST_CONFIG_ERROR", `India Post is not configured: ${missing.join(", ")}.`);
  const { status, ok, data } = await callIndiaPost(`${config.baseUrl}/v1/access/login`, {
    method: "POST",
    body: { username: config.username, password: config.password },
  });
  const token = text(data?.data?.access_token || data?.access_token);
  if (!ok || data?.success === false || !token) {
    throw indiaPostError("INDIA_POST_AUTH_FAILED", `India Post login failed (HTTP ${status}): ${upstreamMessage(data, "invalid username or password")}`, { httpStatus: status });
  }
  const expiresIn = num(data?.data?.expires_in ?? data?.expires_in, 900);
  cachedToken = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

async function authorizedCall(path, options = {}, config = getIndiaPostConfig()) {
  let token = await getIndiaPostToken({ config });
  let result = await callIndiaPost(`${config.baseUrl}${path}`, { ...options, headers: { Authorization: `Bearer ${token}` } });
  if (result.status === 401) {
    token = await getIndiaPostToken({ config, force: true });
    result = await callIndiaPost(`${config.baseUrl}${path}`, { ...options, headers: { Authorization: `Bearer ${token}` } });
  }
  return result;
}

function splitAddress(address) {
  const value = text(address).replace(/\s+/g, " ");
  if (value.length <= 60) return [value, ""];
  const cut = value.lastIndexOf(" ", 60) > 20 ? value.lastIndexOf(" ", 60) : 60;
  return [value.slice(0, cut).trim(), value.slice(cut).trim().slice(0, 100)];
}

const isCod = (order) => {
  const mode = text(order?.payment_mode).toLowerCase();
  if (mode === "cod") return true;
  if (mode === "razorpay") return false;
  return ["cod", "cash on delivery", "cash_on_delivery"].includes(text(order?.payment_method).toLowerCase());
};

/** Amount the postman collects: 0 for prepaid or COD already marked Paid. */
export function codAmountToCollect(order) {
  if (!isCod(order) || text(order?.payment_status).toLowerCase() === "paid") return 0;
  const due = order?.cod_amount_due ?? order?.final_total ?? order?.total_amount;
  const amount = Number(due);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0;
}

/** One ArticleRecord for the bulk-booking API, built from a Tel-Aqua order. */
export function buildIndiaPostArticle(order, { barcode = "", weightGrams, config = getIndiaPostConfig() } = {}) {
  const [line1, line2] = splitAddress(order.address);
  const [senderLine1, senderLine2] = splitAddress(config.sender.address);
  const receiverMobile = text(order.phone).replace(/\D/g, "").slice(-10);
  const article = {
    bulk_customer_id: Number(config.bulkCustomerId),
    contract_id: Number(config.contractId),
    pickup_or_dropoff: config.pickupOrDropoff,
    article_type: config.articleType,
    physical_weight: num(weightGrams, config.weightGrams),
    shape_of_article: "NROL",
    // India Post expects dimensions in millimetres (API onboarding guide); settings are in cm.
    length: Math.round(config.lengthCm * 10),
    breadth_diameter: Math.round(config.breadthCm * 10),
    height: Math.round(config.heightCm * 10),
    instruction_rts: "RTS",
    sender_name: config.sender.name,
    sender_company: config.sender.company,
    sender_add_line_1: senderLine1,
    sender_add_line_2: senderLine2,
    sender_city: config.sender.city,
    sender_state: config.sender.state,
    sender_pincode: config.sender.pincode,
    sender_mobile_no: config.sender.mobile,
    receiver_name: text(order.customer_name).slice(0, 100) || "Customer",
    receiver_add_line_1: line1 || text(order.city),
    receiver_add_line_2: line2,
    receiver_city: text(order.city),
    receiver_state: text(order.state),
    receiver_pincode: text(order.pincode),
    receiver_mobile_no: receiverMobile,
    alt_address_flag: false,
    drop_off_pincode: config.dropoffPincode,
    codr_cod: "COD",
    value_for_codr_cod: codAmountToCollect(order),
    bulk_reference: text(order.order_number || `TAQ-${order.id}`).slice(0, 50),
  };
  if (config.dropoffOfficeId && /^\d+$/.test(config.dropoffOfficeId)) article.pickup_dropoff_office_id = Number(config.dropoffOfficeId);
  if (config.sender.email) article.sender_emailid = config.sender.email;
  if (text(order.email) && !/@guest\.tel-aqua\.in$/i.test(text(order.email))) article.receiver_emailid = text(order.email);
  if (text(barcode)) article.barcode_no = text(barcode).toUpperCase();
  return article;
}

export function validateIndiaPostArticle(article) {
  const errors = [];
  if (!/^\d{6}$/.test(article.receiver_pincode)) errors.push("Customer pincode must be 6 digits.");
  if (!/^\d{10}$/.test(article.receiver_mobile_no)) errors.push("Customer mobile number must be 10 digits.");
  if (!article.receiver_add_line_1 || !article.receiver_city) errors.push("Customer address and city are required.");
  if (article.barcode_no && !/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(article.barcode_no)) errors.push("Article number must look like EB123456789IN.");
  return errors;
}

/**
 * Books one order. Returns { barcode, tariff, raw }.
 * India Post answers per article in valid_articles / error_articles.
 */
export async function bookIndiaPostArticle(order, options = {}) {
  const config = options.config || getIndiaPostConfig();
  const missing = missingIndiaPostSettings(config, { forBooking: true });
  if (missing.length) throw indiaPostError("INDIA_POST_CONFIG_ERROR", `India Post booking is not configured: ${missing.join(", ")}.`);
  const article = buildIndiaPostArticle(order, { ...options, config });
  const invalid = validateIndiaPostArticle(article);
  if (invalid.length) throw indiaPostError("INDIA_POST_ORDER_DATA_INVALID", invalid.join(" "));

  const { status, ok, data } = await authorizedCall(
    `/process-articles-file/${encodeURIComponent(config.customerId)}`,
    { method: "POST", body: { articles: [article] } },
    config
  );
  const rejected = Array.isArray(data?.error_articles) ? data.error_articles[0] : null;
  if (rejected) {
    const reasons = (Array.isArray(rejected.errors) ? rejected.errors : [rejected.error || rejected.message]).filter(Boolean).join("; ");
    throw indiaPostError("INDIA_POST_REJECTED", `India Post rejected the booking: ${reasons || "no reason given"}`, { httpStatus: 422, upstreamBody: data });
  }
  const accepted = Array.isArray(data?.valid_articles) ? data.valid_articles[0] : null;
  if (!ok || data?.success === false || !accepted) {
    throw indiaPostError("INDIA_POST_UPSTREAM_ERROR", `India Post booking failed (HTTP ${status}): ${upstreamMessage(data, "unexpected response")}`, { httpStatus: status, upstreamBody: data });
  }
  const barcode = text(accepted.barcode_no || article.barcode_no).toUpperCase();
  if (!barcode) {
    throw indiaPostError("INDIA_POST_NO_BARCODE", "India Post accepted the booking but returned no article number. Enter the article number from the India Post receipt.", { upstreamBody: data });
  }
  return { barcode, tariff: Number(accepted.calculated_tariff) || null, batchId: data.batch_id || null, raw: data };
}

/** India Post status text -> Tel-Aqua fulfillment status. */
export function mapIndiaPostStatus(status) {
  const value = text(status).toLowerCase();
  if (!value) return null;
  if (/return(ed)? to sender|returned|rts delivered|delivered to sender/.test(value)) return "returned";
  if (/\brts\b|return to sender|return/.test(value)) return "rto";
  if (/not delivered|undelivered|attempt|door locked|addressee (left|absent|not available)|refused|deposit/.test(value)) return "ndr";
  if (/delivered/.test(value)) return "delivered";
  if (/out for delivery|sent for delivery|item onhold|on hold/.test(value)) return "out_for_delivery";
  if (/booked|received at origin|item received|accepted|booking/.test(value)) return "picked_up";
  if (/transit|dispatched|bagged|received|arrival|arrived|forwarded/.test(value)) return "in_transit";
  return null;
}

/** Live tracking for one article. Returns null when India Post has no record yet (404). */
export async function getIndiaPostTracking(barcode, { config = getIndiaPostConfig() } = {}) {
  const id = text(barcode).toUpperCase();
  if (!/^[A-Z0-9]{8,20}$/.test(id)) throw indiaPostError("INDIA_POST_ORDER_DATA_INVALID", "Invalid India Post article number.");
  const { status, ok, data } = await authorizedCall(`/v1/tracking/${encodeURIComponent(id)}`, {}, config);
  if (status === 404) return null;
  if (!ok || data?.success === false) {
    throw indiaPostError("INDIA_POST_UPSTREAM_ERROR", `India Post tracking failed (HTTP ${status}): ${upstreamMessage(data, "unexpected response")}`, { httpStatus: status });
  }
  const body = data?.data || data;
  const history = (Array.isArray(body?.history) ? body.history : []).map((event) => ({
    status: text(event.status || event.event || event.description),
    location: text(event.location || event.office) || null,
    eventTime: event.timestamp || event.date || null,
    raw: event,
  })).filter((event) => event.status);
  const currentStatus = text(body?.currentStatus || body?.status || history.at(-1)?.status);
  return {
    barcode: id,
    currentStatus,
    fulfillmentStatus: mapIndiaPostStatus(currentStatus),
    location: history.at(-1)?.location || null,
    estimatedDelivery: body?.estimatedDelivery || null,
    history,
    raw: data,
  };
}
