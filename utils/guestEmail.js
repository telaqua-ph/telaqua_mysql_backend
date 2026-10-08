const GUEST_EMAIL_DOMAIN = "@guest_telaqua.in";

export function normalizePhoneForGuestEmail(phoneNumber) {
  let digits = String(phoneNumber ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

export function generateGuestEmail(phoneNumber) {
  const normalizedPhone = normalizePhoneForGuestEmail(phoneNumber);
  return normalizedPhone ? `${normalizedPhone}${GUEST_EMAIL_DOMAIN}` : null;
}

export function resolveOrderEmail(email, phoneNumber) {
  const providedEmail = typeof email === "string" ? email.trim() : "";
  return providedEmail || generateGuestEmail(phoneNumber);
}
