/**
 * services/promoService.js
 *
 * Promo-code lookups + admin CRUD against promo_codes.
 * Pricing always comes from the database — never from the client.
 */

import { query } from "../config/db.js";
import {
  evaluatePromoApplicability,
  promoEffectiveStatus,
} from "../utils/promoValidity.js";

const PROMO_COLUMNS = `
  id,
  platform,
  language,
  code,
  original_price,
  promo_price,
  is_active,
  usage_limit,
  used_count,
  created_at,
  updated_at,
  valid_from,
  valid_until
`;

export function normalizePromoCode(code) {
  return String(code ?? "")
    .trim()
    .toUpperCase();
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function toIsoOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function mapPromoRecord(row) {
  const valid_from = toIsoOrNull(row.valid_from);
  const valid_until = toIsoOrNull(row.valid_until);
  const is_active = Boolean(row.is_active);

  return {
    id: row.id,
    platform: row.platform,
    language: row.language,
    code: String(row.code).trim().toUpperCase(),
    original_price: toNumber(row.original_price),
    promo_price: toNumber(row.promo_price),
    is_active,
    usage_limit:
      row.usage_limit === null || row.usage_limit === undefined
        ? null
        : Number(row.usage_limit),
    used_count: Number(row.used_count ?? 0),
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
    valid_from,
    valid_until,
    effective_status: promoEffectiveStatus({
      is_active,
      valid_from: row.valid_from,
      valid_until: row.valid_until,
    }),
  };
}

export function mapPromoPricing(row) {
  const original_price = toNumber(row.original_price);
  const promo_price = toNumber(row.promo_price);
  const discount_amount = original_price - promo_price;

  return {
    code: String(row.code).trim().toUpperCase(),
    platform: row.platform,
    language: row.language,
    original_price,
    promo_price,
    discount_amount,
  };
}

export function isPromoWithinUsageLimit(row) {
  if (row.usage_limit === null || row.usage_limit === undefined) {
    return true;
  }
  const limit = Number(row.usage_limit);
  const used = Number(row.used_count ?? 0);
  if (!Number.isFinite(limit) || !Number.isFinite(used)) return false;
  return used < limit;
}

/** Retired public offer codes — never suggest these on landing. */
const RETIRED_OFFER_CODES = ["WELCOME25", "SAVE500"];

/** Preferred Website / Direct public coupon (matches promo_codes.code). */
const PREFERRED_WEBSITE_DIRECT_CODE = "TELAQUA25";

/**
 * Suggested offer for marketing attribution (platform + language).
 * Prefers TELAQUA25 for Website + Direct; skips retired WELCOME25 / SAVE500.
 */
export async function findOfferByPlatformLanguage(platform, language) {
  const retiredPlaceholders = RETIRED_OFFER_CODES.map(() => "?").join(", ");
  const { rows } = await query(
    `SELECT ${PROMO_COLUMNS}
     FROM promo_codes
     WHERE LOWER(TRIM(platform)) = LOWER(TRIM(?))
       AND LOWER(TRIM(language)) = LOWER(TRIM(?))
       AND is_active = 1
       AND (usage_limit IS NULL OR used_count < usage_limit)
       AND (valid_from IS NULL OR valid_from <= CURRENT_TIMESTAMP)
       AND (valid_until IS NULL OR valid_until >= CURRENT_TIMESTAMP)
       AND UPPER(TRIM(code)) NOT IN (${retiredPlaceholders})
     ORDER BY
       CASE WHEN UPPER(TRIM(code)) = ? THEN 0 ELSE 1 END,
       id ASC
     LIMIT 1`,
    [platform, language, ...RETIRED_OFFER_CODES, PREFERRED_WEBSITE_DIRECT_CODE]
  );

  return rows[0] || null;
}

export async function findPromoByCode(code) {
  const { rows } = await query(
    `SELECT ${PROMO_COLUMNS}
     FROM promo_codes
     WHERE UPPER(TRIM(code)) = ?
     LIMIT 1`,
    [code]
  );

  return rows[0] || null;
}

export async function findActivePromoByCode(code) {
  const row = await findPromoByCode(code);
  if (!row) return null;
  const timeCheck = evaluatePromoApplicability(row);
  if (!timeCheck.ok) return null;
  if (!isPromoWithinUsageLimit(row)) return null;
  return row;
}

export async function incrementPromoUsedCount(code) {
  const normalized = normalizePromoCode(code);
  if (!normalized) return false;

  const { rowCount } = await query(
    `UPDATE promo_codes
     SET used_count = used_count + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE UPPER(TRIM(code)) = ?
       AND is_active = 1
       AND (usage_limit IS NULL OR used_count < usage_limit)`,
    [normalized]
  );

  return rowCount > 0;
}

export async function listPromoCodes(status) {
  let sql = `
    SELECT ${PROMO_COLUMNS}
    FROM promo_codes
  `;

  if (status === "active") {
    sql += ` WHERE is_active = 1`;
  } else if (status === "inactive") {
    sql += ` WHERE is_active = 0`;
  }

  sql += ` ORDER BY id DESC`;

  const { rows } = await query(sql, []);
  return rows;
}

export async function findPromoById(id) {
  const { rows } = await query(
    `SELECT ${PROMO_COLUMNS}
     FROM promo_codes
     WHERE id = ?
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

export async function createPromoCode(data) {
  const result = await query(
    `INSERT INTO promo_codes (
       platform,
       language,
       code,
       original_price,
       promo_price,
       is_active,
       usage_limit,
       used_count,
       created_at,
       updated_at,
       valid_from,
       valid_until
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?
     )`,
    [
      data.platform,
      data.language,
      data.code,
      data.original_price,
      data.promo_price,
      data.is_active ? 1 : 0,
      data.usage_limit,
      data.valid_from,
      data.valid_until,
    ]
  );
  const { rows } = await query(
    `SELECT ${PROMO_COLUMNS} FROM promo_codes WHERE id = ? LIMIT 1`,
    [result.insertId]
  );
  return rows[0];
}

export async function updatePromoCode(id, data) {
  await query(
    `UPDATE promo_codes
     SET
       platform = ?,
       language = ?,
       code = ?,
       original_price = ?,
       promo_price = ?,
       usage_limit = ?,
       valid_from = ?,
       valid_until = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      data.platform,
      data.language,
      data.code,
      data.original_price,
      data.promo_price,
      data.usage_limit,
      data.valid_from,
      data.valid_until,
      id,
    ]
  );
  const { rows } = await query(
    `SELECT ${PROMO_COLUMNS} FROM promo_codes WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

export async function updatePromoCodeStatus(id, isActive) {
  await query(
    `UPDATE promo_codes
     SET
       is_active = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [isActive ? 1 : 0, id]
  );
  const { rows } = await query(
    `SELECT ${PROMO_COLUMNS} FROM promo_codes WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

export async function promoCodeExists(code, excludeId = null) {
  if (excludeId == null) {
    const { rows } = await query(
      `SELECT id FROM promo_codes WHERE UPPER(TRIM(code)) = ? LIMIT 1`,
      [code]
    );
    return rows.length > 0;
  }

  const { rows } = await query(
    `SELECT id FROM promo_codes
     WHERE UPPER(TRIM(code)) = ?
       AND id <> ?
     LIMIT 1`,
    [code, excludeId]
  );
  return rows.length > 0;
}
