/**
 * Farmer Intel Map: automatically adds a map coordinate for every new pincode.
 *
 * The map plots one dot per pincode using pincode_geocodes. That table was
 * seeded once, so orders from new pincodes had no dot. This worker looks up the
 * missing pincodes (OpenStreetMap Nominatim, free, 1 request/second) and saves
 * a pincode-centroid coordinate. If the pincode itself is not found it falls
 * back to the order's city/district centroid. Coordinates are never a farmer's
 * exact location.
 *
 * Env (all optional):
 *   FARMER_INTEL_GEOCODE_ENABLED=true     (set false to switch off)
 *   FARMER_INTEL_GEOCODE_MINUTES=15        (how often the worker runs)
 *   FARMER_INTEL_GEOCODE_BATCH=25          (pincodes per run)
 *   FARMER_INTEL_GEOCODE_CONTACT=email     (sent in the User-Agent, per Nominatim policy)
 */
import { pool } from "../config/db.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const PIN_RE = /^[1-9][0-9]{5}$/;
const RETRY_NOT_FOUND_DAYS = 7;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function geocodeSettings(env = process.env) {
  const enabled = String(env.FARMER_INTEL_GEOCODE_ENABLED ?? "true").trim().toLowerCase() !== "false";
  const minutes = Math.max(5, Number(env.FARMER_INTEL_GEOCODE_MINUTES) || 15);
  const batch = Math.min(100, Math.max(1, Number(env.FARMER_INTEL_GEOCODE_BATCH) || 25));
  const contact = String(env.FARMER_INTEL_GEOCODE_CONTACT || "").trim();
  return { enabled, minutes, batch, contact };
}

function userAgent(contact) {
  return `TelAqua-FarmerIntelMap/1.0${contact ? ` (${contact})` : ""}`;
}

function pickDistrict(address = {}) {
  const raw = address.state_district || address.county || address.city_district || address.city || address.town || "";
  return String(raw).replace(/\s+district$/i, "").trim() || null;
}

async function nominatim(params, { fetchFn = fetch, contact = "" } = {}) {
  const search = new URLSearchParams({ format: "jsonv2", addressdetails: "1", limit: "1", countrycodes: "in", ...params });
  const response = await fetchFn(`${NOMINATIM_URL}?${search}`, {
    headers: { "User-Agent": userAgent(contact), Accept: "application/json", "Accept-Language": "en" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = new Error(`Geocoder HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const list = await response.json();
  const hit = Array.isArray(list) ? list[0] : null;
  const lat = Number(hit?.lat);
  const lng = Number(hit?.lon);
  // Keep results inside India's bounding box only.
  if (!hit || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < 6 || lat > 37.5 || lng < 68 || lng > 97.5) return null;
  return { latitude: Number(lat.toFixed(7)), longitude: Number(lng.toFixed(7)), district: pickDistrict(hit.address), state: hit.address?.state || null };
}

/**
 * Looks up one pincode. Returns { latitude, longitude, district, state, source } or
 * { notFound: true } when neither the pincode nor the order's city could be found.
 */
export async function lookupPincode({ pincode, city, state }, { fetchFn = fetch, contact = "", pause = sleep } = {}) {
  const exact = await nominatim({ postalcode: pincode }, { fetchFn, contact });
  if (exact) return { ...exact, source: "nominatim:pincode" };
  const place = [city, state].map((value) => String(value || "").trim()).filter(Boolean).join(", ");
  if (!place) return { notFound: true };
  await pause(1100);
  const approx = await nominatim({ q: `${place}, India` }, { fetchFn, contact });
  if (approx) return { ...approx, district: approx.district || String(city || "").trim() || null, state: approx.state || state || null, source: "nominatim:city-centroid" };
  return { notFound: true };
}

/** Pincodes of real orders (COD or paid, not test) that have no usable coordinate yet. */
export async function findMissingPincodes({ db = pool, limit = 25 } = {}) {
  const { rows } = await db.query(
    `SELECT TRIM(o.pincode) AS pincode, MAX(o.city) AS city, MAX(o.state) AS state, MAX(o.created_at) AS last_order_at
     FROM orders o
     LEFT JOIN pincode_geocodes g ON g.pincode = TRIM(o.pincode)
     WHERE (o.is_test_order = 0 OR o.is_test_order IS NULL)
       AND (LOWER(TRIM(COALESCE(o.payment_mode, ''))) = 'cod' OR LOWER(TRIM(COALESCE(o.payment_status, ''))) = 'paid')
       AND TRIM(o.pincode) REGEXP '^[1-9][0-9]{5}$'
       AND (
         g.pincode IS NULL
         OR (g.latitude IS NULL AND (g.source_updated_at IS NULL OR g.source_updated_at < DATE_SUB(NOW(), INTERVAL ${RETRY_NOT_FOUND_DAYS} DAY)))
       )
     GROUP BY TRIM(o.pincode)
     ORDER BY last_order_at DESC
     LIMIT ${Math.max(1, Math.min(500, Number(limit) || 25))}`
  );
  return rows.filter((row) => PIN_RE.test(String(row.pincode || "")));
}

export async function savePincodeGeocode(db, pincode, result) {
  await db.query(
    `INSERT INTO pincode_geocodes (pincode, district, state, latitude, longitude, source_name, source_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       district = COALESCE(VALUES(district), district),
       state = COALESCE(VALUES(state), state),
       latitude = VALUES(latitude),
       longitude = VALUES(longitude),
       source_name = VALUES(source_name),
       source_updated_at = NOW()`,
    [
      pincode,
      result.notFound ? null : result.district,
      result.notFound ? null : result.state,
      result.notFound ? null : result.latitude,
      result.notFound ? null : result.longitude,
      result.notFound ? "nominatim:not-found" : result.source,
    ]
  );
}

let running = false;
/** One pass: geocode up to `batch` missing pincodes, 1 request per second. */
export async function runPincodeGeocodeSync({ db = pool, env = process.env, fetchFn = fetch, pause = sleep, limit } = {}) {
  if (running) return { skipped: true };
  running = true;
  const { batch, contact } = geocodeSettings(env);
  const summary = { checked: 0, added: 0, notFound: 0, failed: 0 };
  try {
    const missing = await findMissingPincodes({ db, limit: limit || batch });
    for (const row of missing) {
      summary.checked += 1;
      try {
        const result = await lookupPincode(row, { fetchFn, contact, pause });
        await savePincodeGeocode(db, row.pincode, result);
        if (result.notFound) summary.notFound += 1; else summary.added += 1;
      } catch (error) {
        summary.failed += 1;
        // Rate limited or blocked: stop this run and try again next time.
        if (error?.status === 429 || error?.status === 403) break;
      }
      await pause(1100);
    }
    if (summary.checked) console.log("Farmer Intel pincode geocode sync", summary);
    return summary;
  } catch (error) {
    if (error?.code !== "ER_NO_SUCH_TABLE") console.warn("Farmer Intel pincode geocode sync failed", { message: error?.message });
    return { ...summary, error: error?.message };
  } finally {
    running = false;
  }
}

let timer = null;
let startupTimer = null;
export function startPincodeGeocodeSync(env = process.env) {
  const { enabled, minutes } = geocodeSettings(env);
  if (!enabled || timer) return timer;
  timer = setInterval(() => { runPincodeGeocodeSync(); }, minutes * 60 * 1000);
  timer.unref?.();
  startupTimer = setTimeout(() => { runPincodeGeocodeSync(); }, 45_000);
  startupTimer.unref?.();
  console.log("Farmer Intel pincode geocode sync started", { minutes });
  return timer;
}

export function stopPincodeGeocodeSync() {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
}
