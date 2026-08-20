import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const CUSTOMER_TOKEN_DAYS = 7;

function getCustomerSecret() {
  // A dedicated secret is preferred. If it is missing or unusably short,
  // retain compatibility with a sufficiently strong existing admin secret.
  // Customer keys are purpose-derived, so customer JWTs cannot verify as
  // admin JWTs (or vice versa).
  const dedicated = String(process.env.CUSTOMER_AUTH_SECRET || "").trim();
  const fallback = String(process.env.JWT_SECRET || "").trim();
  const secret = dedicated.length >= 24 ? dedicated :
    fallback.length >= 24 ? fallback : "";
  if (!secret) {
    throw new Error("CUSTOMER_AUTH_SECRET (or JWT_SECRET fallback) must contain at least 24 characters");
  }
  return secret;
}

export function getCustomerAuthConfigurationStatus() {
  const dedicated = String(process.env.CUSTOMER_AUTH_SECRET || "").trim();
  const fallback = String(process.env.JWT_SECRET || "").trim();
  return {
    dedicatedSecretConfigured: Boolean(dedicated),
    dedicatedSecretUsable: dedicated.length >= 24,
    jwtFallbackConfigured: Boolean(fallback),
    jwtFallbackUsable: fallback.length >= 24,
    selectedSource: dedicated.length >= 24 ? "CUSTOMER_AUTH_SECRET" :
      fallback.length >= 24 ? "JWT_SECRET" : null,
  };
}

function derivedKey(purpose) {
  return crypto.createHmac("sha256", getCustomerSecret())
    .update(`telaqua:${purpose}:v1`)
    .digest();
}

export function generateOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashOtp(phone, otp, salt = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.createHmac("sha256", derivedKey("otp"))
    .update(`${salt}:${phone}:${otp}`)
    .digest("hex");
  return `${salt}:${digest}`;
}

export function verifyOtpHash(phone, otp, storedHash) {
  const [salt, expected] = String(storedHash || "").split(":");
  if (!salt || !expected) return false;
  const actual = hashOtp(phone, otp, salt).split(":")[1];
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  return left.length === right.length && left.length > 0 &&
    crypto.timingSafeEqual(left, right);
}

export function hashRequestIp(ip) {
  return crypto.createHmac("sha256", derivedKey("request-ip"))
    .update(String(ip || "unknown"))
    .digest("hex");
}

export function customerSessionExpiry(now = new Date()) {
  return new Date(now.getTime() + CUSTOMER_TOKEN_DAYS * 24 * 60 * 60 * 1000);
}

export function signCustomerToken({ phone, tokenId }) {
  return jwt.sign(
    { phone, token_type: "customer" },
    derivedKey("jwt"),
    {
      algorithm: "HS256",
      audience: "telaqua-customer",
      issuer: "telaqua-api",
      subject: phone,
      jwtid: tokenId,
      expiresIn: `${CUSTOMER_TOKEN_DAYS}d`,
    }
  );
}

export function verifyCustomerToken(token) {
  const payload = jwt.verify(token, derivedKey("jwt"), {
    algorithms: ["HS256"],
    audience: "telaqua-customer",
    issuer: "telaqua-api",
  });
  if (payload?.token_type !== "customer" || !payload?.jti || !payload?.phone) {
    throw new Error("Invalid customer token");
  }
  return payload;
}
