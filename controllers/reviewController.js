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
    query(`SELECT id, rating, title, body, customer_name, created_at, (photo_data IS NOT NULL) AS has_photo, (photo2_data IS NOT NULL) AS has_photo2 FROM product_reviews
      WHERE product_key = ? AND status = 'published' ORDER BY ${order} LIMIT 100`, [PRODUCT_KEY]),
  ]);
  return res.json({ success: true, average_rating: Number(summary.rows[0]?.average_rating || 0), review_count: Number(summary.rows[0]?.review_count || 0), reviews: reviews.rows.map((row) => ({ ...row, customer_name: customerName(row.customer_name).split(" ")[0] })) });
}

export async function getPublicReviewPhoto(req, res) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.sendStatus(404);
  const second = req.params.number === '2';
  const columns = second ? 'photo2_data AS photo_data, photo2_type AS photo_type' : 'photo_data, photo_type';
  const { rows } = await query(`SELECT ${columns} FROM product_reviews WHERE id = ? AND product_key = ? AND status = 'published' LIMIT 1`, [id, PRODUCT_KEY]);
  const photo = rows[0];
  if (!photo?.photo_data || !['image/jpeg', 'image/png', 'image/webp'].includes(photo.photo_type)) return res.sendStatus(404);
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Cache-Control', 'public, max-age=300');
  res.type(photo.photo_type).send(photo.photo_data);
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
  const inputPhotos = req.body?.photos === undefined ? (req.body?.photo ? [req.body.photo] : []) : req.body.photos;
  if (!Array.isArray(inputPhotos) || inputPhotos.length > 2) return res.status(400).json({ success: false, message: "Choose up to two product photos." });
  const photos = [];
  for (const value of inputPhotos) {
    const match = String(value).match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2].length > 2796204) return res.status(400).json({ success: false, message: "Please choose a JPEG, PNG or WebP photo under 2 MB." });
    const bytes = Buffer.from(match[2], "base64");
    const valid = match[1] === "jpeg" ? bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) : match[1] === "png" ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
    if (!valid || bytes.length > 2 * 1024 * 1024) return res.status(400).json({ success: false, message: "Please choose a valid JPEG, PNG or WebP photo under 2 MB." });
    photos.push({ bytes, type: `image/${match[1]}` });
  }
  if (!Number.isInteger(orderId) || orderId < 1 || !Number.isInteger(rating) || rating < 1 || rating > 5 || title.length < 3 || body.length < 10) {
    return res.status(400).json({ success: false, message: "Enter a rating, a short title, and at least 10 characters of feedback." });
  }
  const owned = await query(`SELECT o.id, o.customer_name FROM orders o LEFT JOIN shipments s ON s.order_id = o.id AND s.sequence_no = 1
    WHERE o.id = ? AND ${PHONE_MATCH_SQL} AND ${DELIVERED_SQL} LIMIT 1`, [orderId, req.customer.phone]);
  if (!owned.rows[0]) return res.status(403).json({ success: false, message: "Only your delivered Tel-Aqua pH Meter orders can be reviewed." });
  try {
    await query(`INSERT INTO product_reviews (product_key, order_id, customer_phone, customer_name, rating, title, body, status, photo_data, photo_type, photo2_data, photo2_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?)`, [PRODUCT_KEY, orderId, req.customer.phone, customerName(owned.rows[0].customer_name), rating, title, body, photos[0]?.bytes || null, photos[0]?.type || null, photos[1]?.bytes || null, photos[1]?.type || null]);
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") return res.status(409).json({ success: false, message: "You have already submitted a review for this order." });
    throw error;
  }
  return res.status(201).json({ success: true, message: "Thank you. Your review is now published." });
}
