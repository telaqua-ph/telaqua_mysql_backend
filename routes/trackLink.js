/**
 * routes/trackLink.js
 *
 * Public customer tracking link sent on WhatsApp (Interakt "Track order" button):
 *   Template button URL:  https://<BACKEND_BASE_URL>/t/{{1}}     ({{1}} = AWB)
 *   GET /t/<AWB>   -> 302 redirect to that shipment's tracking page
 *                     (Shipway: https://telaqua.shipway.com/tracking/forward/<AWB>/)
 *   GET /t/        -> info page (200) for Meta / reviewers checking the static URL
 *   GET /t/?<AWB>  -> same as /t/<AWB> (SMS-style link, like /i/?<ref>)
 *
 * Only AWBs that exist in our shipments/orders are redirected, and only to the
 * fixed tracking site for that shipment's provider, so this is never an open redirect.
 */
import { Router } from "express";
import { pool } from "../config/db.js";
import { trackingUrlFor } from "../services/shipmentTrackingNotificationService.js";

const router = Router();
const AWB_PATTERN = /^[A-Za-z0-9-]{4,40}$/;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body style="font-family:Arial,sans-serif;margin:0;color:#14213D;background:#F5F8FB">
<div style="background:#063970;color:#fff;padding:32px 20px;text-align:center">
<h1 style="margin:0;font-size:26px">Tel-Aqua Order Tracking</h1>
<p style="margin:8px 0 0">AQUA AI PRIVATE LIMITED &middot; Water-quality instruments</p></div>
<div style="max-width:560px;margin:32px auto;padding:0 20px;line-height:1.6">${body}
<p><a href="https://telaqua.in" style="display:inline-block;background:#063970;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Visit telaqua.in</a></p>
</div></body></html>`;

// Shown when the base link (/t/) is opened without an AWB, e.g. by Meta reviewing the template URL.
export const TRACKING_INFO_PAGE = page("Tel-Aqua Order Tracking",
  `<p>When an order from telaqua.in is shipped, the customer receives a WhatsApp message with a personal "Track order" link.</p>
<p>Each link contains that shipment's tracking (AWB) number and opens the live courier tracking page for that order only.</p>`);

const NOT_FOUND_PAGE = page("Tracking not found",
  `<p>We could not find a shipment for this tracking link. Please check the link in your WhatsApp message, or contact Tel-Aqua support on WhatsApp at +91 89775 91115.</p>`);

/** "/t/?SMMC123" -> "SMMC123" (first raw query key, no "=value"). */
export function awbFromQueryString(originalUrl) {
  const qs = String(originalUrl || "").split("?")[1] || "";
  const first = qs.split("&")[0].split("=")[0];
  try {
    return decodeURIComponent(first).trim();
  } catch {
    return "";
  }
}

/** Provider for a known AWB, or null when we have no such shipment. */
async function findShipmentProvider(awb, db) {
  const shipment = await db.query(
    "SELECT provider FROM shipments WHERE waybill_number = ? ORDER BY id DESC LIMIT 1",
    [awb]
  );
  if (shipment.rows[0]) return shipment.rows[0].provider || "Delhivery";
  const order = await db.query("SELECT id FROM orders WHERE waybill = ? LIMIT 1", [awb]);
  return order.rows[0] ? "Delhivery" : null;
}

export function createTrackLinkRouter({ db = pool } = {}) {
  const r = Router();

  async function redirectToTracking(rawAwb, res) {
    res.setHeader("Cache-Control", "private, no-store");
    const awb = String(rawAwb || "").trim();
    if (!AWB_PATTERN.test(awb)) return res.status(404).type("html").send(NOT_FOUND_PAGE);
    let provider;
    try {
      provider = await findShipmentProvider(awb, db);
    } catch (error) {
      console.error("Tracking link lookup failed:", { code: error?.code, message: String(error?.message || "").slice(0, 200) });
      return res.status(503).type("html").send(page("Tracking unavailable",
        "<p>Tracking is temporarily unavailable. Please try again in a few minutes.</p>"));
    }
    if (!provider) return res.status(404).type("html").send(NOT_FOUND_PAGE);
    return res.redirect(302, trackingUrlFor(awb, provider));
  }

  r.get("/", (req, res) => {
    const awb = awbFromQueryString(req.originalUrl);
    if (!awb) {
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.status(200).type("html").send(TRACKING_INFO_PAGE);
    }
    return redirectToTracking(awb, res);
  });
  r.get("/:awb", (req, res) => redirectToTracking(req.params.awb, res));
  return r;
}

router.use(createTrackLinkRouter());
export default router;
