import { query } from "../config/db.js";

const PRODUCT_KEY = "telaqua-ph-meter";
const PHONE_MATCH_SQL = "BINARY RIGHT(REGEXP_REPLACE(o.phone, '[^0-9]', ''), 10) = ?";
const DELIVERED_SQL = `(
  LOWER(COALESCE(o.order_status, '')) IN ('delivered', 'completed', 'fulfilled')
  OR LOWER(COALESCE(o.shipment_status, '')) IN ('delivered', 'completed', 'fulfilled')
  OR LOWER(COALESCE(o.tracking_status, '')) IN ('delivered', 'completed', 'fulfilled')
  OR LOWER(COALESCE(s.fulfillment_status, '')) IN ('delivered', 'completed', 'fulfilled')
  OR LOWER(COALESCE(s.shipment_status, '')) IN ('delivered', 'completed', 'fulfilled')
)`;

const clean = (value, max) => String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
const customerName = (name) => clean(name, 120) || "Verified buyer";

export async function getPublicPhMeterReviews(req, res) {
  const sort = String(req.query.sort || "recent").toLowerCase();
  const order = sort === "highest" ? "rating DESC, created_at DESC" : sort === "lowest" ? "rating ASC, created_at DESC" : "created_at DESC";
  const [summary, reviews] = await Promise.all([
    query(`SELECT COUNT(*) AS review_count, COALESCE(ROUND(AVG(rating), 1), 0) AS average_rating
      FROM product_reviews WHERE product_key = ? AND status = 'published'`, [PRODUCT_KEY]),
    query(`SELECT rating, title, body, customer_name, created_at FROM product_reviews
      WHERE product_key = ? AND status = 'published' ORDER BY ${order} LIMIT 100`, [PRODUCT_KEY]),
  ]);
  return res.json({ success: true, average_rating: Number(summary.rows[0]?.average_rating || 0), review_count: Number(summary.rows[0]?.review_count || 0), reviews: reviews.rows.map((row) => ({ ...row, customer_name: customerName(row.customer_name).split(" ")[0] })) });
}

export async function getEligibleReviewOrders(req, res) {
  const { rows } = await query(`SELECT o.id, o.order_number, o.created_at, o.quantity,
      COALESCE(s.shipment_status, o.shipment_status) AS shipment_status,
      COALESCE(s.fulfillment_status, '') AS fulfillment_status
    FROM orders o LEFT JOIN shipments s ON s.order_id = o.id AND s.sequence_no = 1
    LEFT JOIN product_reviews r ON r.order_id = o.id
    WHERE ${PHONE_MATCH_SQL} AND ${DELIVERED_SQL} AND r.id IS NULL
    ORDER BY o.created_at DESC, o.id DESC`, [req.customer.phone]);
  return res.json({ success: true, orders: rows });
}

export async function createReview(req, res) {
  const orderId = Number(req.body?.order_id);
  const rating = Number(req.body?.rating);
  const title = clean(req.body?.title, 140);
  const body = clean(req.body?.body, 2000);
  if (!Number.isInteger(orderId) || orderId < 1 || !Number.isInteger(rating) || rating < 1 || rating > 5 || title.length < 3 || body.length < 10) {
    return res.status(400).json({ success: false, message: "Enter a rating, a short title, and at least 10 characters of feedback." });
  }
  const owned = await query(`SELECT o.id, o.customer_name FROM orders o LEFT JOIN shipments s ON s.order_id = o.id AND s.sequence_no = 1
    WHERE o.id = ? AND ${PHONE_MATCH_SQL} AND ${DELIVERED_SQL} LIMIT 1`, [orderId, req.customer.phone]);
  if (!owned.rows[0]) return res.status(403).json({ success: false, message: "Only your delivered Tel-Aqua pH Meter orders can be reviewed." });
  try {
    await query(`INSERT INTO product_reviews (product_key, order_id, customer_phone, customer_name, rating, title, body)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [PRODUCT_KEY, orderId, req.customer.phone, customerName(owned.rows[0].customer_name), rating, title, body]);
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") return res.status(409).json({ success: false, message: "You have already submitted a review for this order." });
    throw error;
  }
  return res.status(201).json({ success: true, message: "Thank you. Your review was submitted for checking before publication." });
}
