/**
 * utils/phoneUtils.js
 *
 * Normalize Indian phone numbers for Interakt (+91).
 */

/**
 * @param {unknown} raw
 * @returns {{ countryCode: string, phoneNumber: string } | { error: string }}
 */
export function normalizeIndianPhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");

  if (!digits) {
    return { error: "Customer phone number is missing" };
  }

  if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  if (digits.length !== 10) {
    return { error: "Customer phone number is invalid" };
  }

  if (!/^[6-9]\d{9}$/.test(digits)) {
    return { error: "Customer phone number is invalid" };
  }

  return {
    countryCode: "+91",
    phoneNumber: digits,
  };
}
