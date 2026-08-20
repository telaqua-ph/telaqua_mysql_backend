/**
 * Promo coupon validity (IST / Asia/Kolkata).
 *
 * Admin datetime-local values are wall-clock IST, not browser-local.
 * Comparisons use the actual instant (hours and minutes included).
 */

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Parse admin/API datetime as an absolute instant.
 * Naive "YYYY-MM-DDTHH:mm" (no zone) is treated as IST.
 * Values with Z or an offset are treated as absolute timestamps.
 *
 * @param {unknown} value
 * @returns {{ ok: true, date: Date|null } | { ok: false, error: string }}
 */
export function parsePromoDateTime(value) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, date: null };
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return { ok: false, error: "Invalid date" };
    }
    return { ok: true, date: value };
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return { ok: false, error: "Invalid date" };
    }
    return { ok: true, date };
  }

  const raw = String(value).trim();
  if (!raw) return { ok: true, date: null };

  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(raw)) {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      return { ok: false, error: "Invalid date" };
    }
    return { ok: true, date };
  }

  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/
  );
  if (!match) {
    return { ok: false, error: "Invalid date" };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);

  const utcMs =
    Date.UTC(year, month - 1, day, hour, minute, second) - IST_OFFSET_MS;
  const date = new Date(utcMs);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: "Invalid date" };
  }
  return { ok: true, date };
}

/**
 * @param {unknown} value
 * @returns {Date|null}
 */
export function toDateOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = parsePromoDateTime(value);
  return parsed.ok ? parsed.date : null;
}

/**
 * Validate optional valid_from / valid_until pair for create/update.
 * @param {unknown} validFromRaw
 * @param {unknown} validUntilRaw
 * @returns {{ ok: true, valid_from: Date|null, valid_until: Date|null } | { ok: false, error: string }}
 */
export function parsePromoValidityRange(validFromRaw, validUntilRaw) {
  const fromParsed = parsePromoDateTime(validFromRaw);
  if (!fromParsed.ok) {
    return { ok: false, error: "valid_from is invalid" };
  }
  const untilParsed = parsePromoDateTime(validUntilRaw);
  if (!untilParsed.ok) {
    return { ok: false, error: "valid_until is invalid" };
  }

  const valid_from = fromParsed.date;
  const valid_until = untilParsed.date;

  if (valid_from && valid_until && valid_until.getTime() <= valid_from.getTime()) {
    return { ok: false, error: "Valid until must be later than valid from." };
  }

  return { ok: true, valid_from, valid_until };
}

/**
 * Checkout/apply rules. Time comparison includes hours and minutes.
 * @param {object} row
 * @param {Date} [now]
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function evaluatePromoApplicability(row, now = new Date()) {
  if (!row) {
    return { ok: false, message: "Invalid or inactive promo code" };
  }

  if (!row.is_active) {
    return { ok: false, message: "This coupon is currently inactive." };
  }

  const current = now instanceof Date ? now : new Date(now);
  const validFrom = toDateOrNull(row.valid_from);
  const validUntil = toDateOrNull(row.valid_until);

  if (validFrom && current.getTime() < validFrom.getTime()) {
    return { ok: false, message: "This coupon is not active yet." };
  }

  if (validUntil && current.getTime() > validUntil.getTime()) {
    return { ok: false, message: "This coupon has expired." };
  }

  return { ok: true };
}

/**
 * Admin list effective status.
 * @param {object} row
 * @param {Date} [now]
 * @returns {"Inactive"|"Scheduled"|"Active"|"Expired"}
 */
export function promoEffectiveStatus(row, now = new Date()) {
  if (!row || !row.is_active) return "Inactive";

  const current = now instanceof Date ? now : new Date(now);
  const validFrom = toDateOrNull(row.valid_from);
  const validUntil = toDateOrNull(row.valid_until);

  if (validFrom && current.getTime() < validFrom.getTime()) return "Scheduled";
  if (validUntil && current.getTime() > validUntil.getTime()) return "Expired";
  return "Active";
}
