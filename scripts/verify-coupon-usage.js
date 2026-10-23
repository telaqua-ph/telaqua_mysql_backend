/**
 * Read-only check of the Discounts "Used" (unique successful customers) numbers.
 * Usage: node scripts/verify-coupon-usage.js
 * Runs SELECT queries only — nothing is written.
 */

import "dotenv/config";
import { pool, query } from "../config/db.js";
import {
  buildEligibleCouponOrdersSql,
  countUniqueCustomersByCoupon,
  customerKey,
} from "../services/couponUsageService.js";
import { normalizePromoCode } from "../services/promoService.js";

try {
  const sql = await buildEligibleCouponOrdersSql();
  if (!sql) throw new Error("orders.promo_code column not found");

  const { rows: eligible } = await query(sql);
  const { rows: all } = await query(
    `SELECT id, promo_code FROM orders WHERE TRIM(COALESCE(promo_code, '')) <> ''`
  );
  const { rows: promos } = await query(`SELECT code, used_count FROM promo_codes ORDER BY id`);

  const counts = countUniqueCustomersByCoupon(eligible);
  const tally = (list) => {
    const m = new Map();
    for (const r of list) {
      const c = normalizePromoCode(r.promo_code);
      m.set(c, (m.get(c) || 0) + 1);
    }
    return m;
  };
  const allByCode = tally(all);
  const eligibleByCode = tally(eligible);

  const codes = new Set([...promos.map((p) => normalizePromoCode(p.code)), ...allByCode.keys()]);
  const table = [...codes].map((code) => ({
    code,
    "orders with code": allByCode.get(code) || 0,
    "eligible orders": eligibleByCode.get(code) || 0,
    "UNIQUE CUSTOMERS (new Used)": counts.get(code) || 0,
    "old used_count": promos.find((p) => normalizePromoCode(p.code) === code)?.used_count ?? "-",
  }));
  console.table(table);

  const noKey = eligible.filter((r) => !customerKey(r)).length;
  if (noKey) console.log(`Eligible orders skipped (no phone/email): ${noKey}`);
} catch (error) {
  console.error("Failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  await pool.end?.().catch?.(() => {});
}
