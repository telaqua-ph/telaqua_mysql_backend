import { pool } from "../config/db.js";

const query = (sql, params = []) => pool.query(sql, params);

export async function upsertCheckoutLead(data) {
  const payload = JSON.stringify(data);
  const result = await query(
    `INSERT INTO checkout_leads
       (session_id, lead_status, customer_name, phone, email, address, city, state, pincode,
        product_name, product_id, quantity, original_amount, discount_amount, final_amount,
        promo_code, payment_method, checkout_url, lead_source, payload, last_activity_at)
     VALUES (?, 'started', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       lead_status = IF(lead_status = 'converted', 'converted', 'in_progress'),
       customer_name = VALUES(customer_name), phone = VALUES(phone), email = VALUES(email),
       address = VALUES(address), city = VALUES(city), state = VALUES(state), pincode = VALUES(pincode),
       product_name = VALUES(product_name), product_id = VALUES(product_id), quantity = VALUES(quantity),
       original_amount = VALUES(original_amount), discount_amount = VALUES(discount_amount),
       final_amount = VALUES(final_amount), promo_code = VALUES(promo_code), payment_method = VALUES(payment_method),
       checkout_url = VALUES(checkout_url), lead_source = VALUES(lead_source), payload = VALUES(payload),
       last_activity_at = NOW(), id = LAST_INSERT_ID(id)`,
    [data.checkout_session_id, data.customer_name || null, data.phone || null, data.email || null,
      data.address || null, data.city || null, data.state || null, data.pincode || null,
      data.product_name || null, data.product_id || null, data.quantity || null,
      data.original_amount || null, data.discount_amount || null, data.final_amount || null,
      data.promo_code || null, data.payment_method || null, data.checkout_url || null,
      data.lead_source || 'checkout', payload]
  );
  return result.insertId;
}

export async function listCheckoutLeads({ limit = 500 } = {}) {
  const { rows } = await query(
    `SELECT id, lead_status, customer_name, phone, email, address, city, state, pincode,
       product_name, product_id, quantity, original_amount, discount_amount, final_amount AS product_amount,
       promo_code, payment_method, created_at, last_activity_at AS updated_at
     FROM checkout_leads WHERE lead_status <> 'converted'
     ORDER BY last_activity_at DESC LIMIT ?`, [Number(limit) || 500]
  );
  return rows;
}
