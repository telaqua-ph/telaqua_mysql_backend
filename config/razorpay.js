/**
 * config/razorpay.js
 *
 * Razorpay client factory — credentials from environment only.
 */

import Razorpay from "razorpay";

/**
 * Build a Razorpay client from environment variables.
 * Never hardcode key_id or key_secret.
 */
export function getRazorpayClient() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    throw new Error(
      "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be configured"
    );
  }

  return new Razorpay({
    key_id,
    key_secret,
  });
}
