import { getShipwayConfig } from "../config/shipwayConfig.js";

const ENDPOINT = "https://app.shipway.com/api/v2orders";
const TIMEOUT_MS = 20_000;

export function assertShipwayBookingSucceeded(body) {
  const awb = String(body?.awb_response?.AWB || "").trim();
  const labelUrl = String(body?.awb_response?.shipping_url || "").trim();
  if (body?.success === true && body?.awb_response?.success === true && awb && labelUrl) {
    return { awb, labelUrl, carrierId: String(body.awb_response.carrier_id || "").trim() || null };
  }
  const error = new Error("Shipway did not confirm both order booking and AWB label generation.");
  error.code = "SHIPWAY_PARTIAL_OR_REJECTED";
  error.upstreamBody = body || null;
  throw error;
}

/** Exactly one booking request: retries after an uncertain outcome can duplicate a courier order. */
export async function createShipwayShipment(payload) {
  const config = getShipwayConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const authorization = Buffer.from(`${config.email}:${config.licenseKey}`, "utf8").toString("base64");
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Basic ${authorization}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(String(body?.message || `Shipway API returned HTTP ${response.status}`));
      error.code = "SHIPWAY_UPSTREAM_ERROR";
      error.status = response.status;
      error.upstreamBody = body;
      throw error;
    }
    return { body, booking: assertShipwayBookingSucceeded(body) };
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
