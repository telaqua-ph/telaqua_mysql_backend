/**
 * Server-side order pricing for website checkout.
 * Never trust client unit_price / total_amount.
 * Keep PRODUCT_PRICE in sync with paymentController.js.
 */

import {
  findPromoByCode,
  mapPromoPricing,
  isPromoWithinUsageLimit,
} from "./promoService.js";
import { evaluatePromoApplicability } from "../utils/promoValidity.js";

/** Default PH meter unit price when no promo is applied. */
export const PRODUCT_PRICE = 2999;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Resolve unit/total pricing from DB promo or default product price.
 * @param {{ quantity: number, promo_code: string|null }} orderData
 */
export async function resolveOrderPricing(orderData) {
  const quantity = orderData.quantity;

  if (!orderData.promo_code) {
    const unit_price = PRODUCT_PRICE;
    return {
      promo_code: null,
      unit_price,
      original_amount: unit_price * quantity,
      discount_amount: 0,
      total_amount: unit_price * quantity,
    };
  }

  const row = await findPromoByCode(orderData.promo_code);
  if (!row) {
    return { error: "Invalid or inactive promo code" };
  }

  const timeCheck = evaluatePromoApplicability(row);
  if (!timeCheck.ok) {
    return { error: timeCheck.message };
  }

  if (!isPromoWithinUsageLimit(row)) {
    return { error: "This coupon has reached its usage limit" };
  }

  const promo = mapPromoPricing(row);
  if (
    !Number.isFinite(promo.original_price) ||
    !Number.isFinite(promo.promo_price) ||
    promo.promo_price <= 0 ||
    promo.original_price < promo.promo_price
  ) {
    return { error: "Promo pricing is invalid" };
  }

  const unit_price = promo.promo_price;
  const original_amount = promo.original_price * quantity;
  const total_amount = promo.promo_price * quantity;
  const discount_amount = original_amount - total_amount;

  return {
    promo_code: promo.code,
    unit_price,
    original_amount,
    discount_amount,
    total_amount,
  };
}

export function buildFinancialSnapshot(pricing) {
  const gstRate = 18;
  const shippingAmount = 0;
  const finalTotal = round2(pricing.total_amount + shippingAmount);
  const taxableAmount = round2(pricing.total_amount / (1 + gstRate / 100));
  const gstAmount = round2(pricing.total_amount - taxableAmount);
  return {
    subtotal: round2(pricing.original_amount),
    taxableAmount,
    gstAmount,
    gstRate,
    shippingAmount,
    finalTotal,
  };
}
