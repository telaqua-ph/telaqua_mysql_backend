/**
 * controllers/promoController.js
 *
 * Promo offer lookup + code validation.
 * Never increments used_count — that happens only after payment verify.
 */

import {
  normalizePromoCode,
  mapPromoPricing,
  findOfferByPlatformLanguage,
  findPromoByCode,
  isPromoWithinUsageLimit,
} from "../services/promoService.js";
import { evaluatePromoApplicability } from "../utils/promoValidity.js";

const ALLOWED_PLATFORMS = [
  "Facebook",
  "Instagram",
  "YouTube",
  "WhatsApp",
  "Website",
];

const ALLOWED_LANGUAGES = ["Telugu", "Hindi", "Direct"];

/**
 * GET /api/promo/offer?platform=&language=
 */
export async function getPromoOffer(req, res) {
  try {
    const platform = String(req.query.platform ?? "").trim();
    const language = String(req.query.language ?? "").trim();

    if (!platform) {
      return res.status(400).json({
        success: false,
        message: "platform is required",
      });
    }

    if (!language) {
      return res.status(400).json({
        success: false,
        message: "language is required",
      });
    }

    const platformOk = ALLOWED_PLATFORMS.some(
      (p) => p.toLowerCase() === platform.toLowerCase()
    );
    if (!platformOk) {
      return res.status(400).json({
        success: false,
        message: `Invalid platform. Allowed: ${ALLOWED_PLATFORMS.join(", ")}`,
      });
    }

    const languageOk = ALLOWED_LANGUAGES.some(
      (l) => l.toLowerCase() === language.toLowerCase()
    );
    if (!languageOk) {
      return res.status(400).json({
        success: false,
        message: `Invalid language. Allowed: ${ALLOWED_LANGUAGES.join(", ")}`,
      });
    }

    const row = await findOfferByPlatformLanguage(platform, language);
    if (!row) {
      return res.status(404).json({
        success: false,
        message: "No promotional offer available",
      });
    }

    const promo = mapPromoPricing(row);

    return res.status(200).json({
      success: true,
      promo: {
        code: promo.code,
        platform: promo.platform,
        language: promo.language,
        original_price: promo.original_price,
        promo_price: promo.promo_price,
        discount_amount: promo.discount_amount,
      },
    });
  } catch (error) {
    console.error("Promo offer error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/**
 * POST /api/promo/validate
 * Body: { "code": "PONDFBT" } — also accepts promo_code / coupon_code aliases.
 * Lookup is by code only (any platform/language). Does not increment used_count.
 */
export async function validatePromoCode(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    // Prefer code; accept promo_code / coupon_code for create-order consistency
    const rawCode =
      body.code !== undefined && body.code !== null && body.code !== ""
        ? body.code
        : body.promo_code !== undefined &&
            body.promo_code !== null &&
            body.promo_code !== ""
          ? body.promo_code
          : body.coupon_code !== undefined &&
              body.coupon_code !== null &&
              body.coupon_code !== ""
            ? body.coupon_code
            : null;
    const code = normalizePromoCode(rawCode);

    if (!code) {
      return res.status(400).json({
        success: false,
        message: "code is required",
      });
    }

    const row = await findPromoByCode(code);
    if (!row) {
      return res.status(400).json({
        success: false,
        valid: false,
        message: "Invalid or inactive promo code",
      });
    }

    if (!row.is_active) {
      return res.status(400).json({
        success: false,
        valid: false,
        message: "This coupon is currently inactive.",
      });
    }

    const timeCheck = evaluatePromoApplicability(row);
    if (!timeCheck.ok) {
      return res.status(400).json({
        success: false,
        valid: false,
        message: timeCheck.message,
      });
    }

    if (!isPromoWithinUsageLimit(row)) {
      return res.status(400).json({
        success: false,
        valid: false,
        message: "This coupon has reached its usage limit",
      });
    }

    const promo = mapPromoPricing(row);

    return res.status(200).json({
      success: true,
      valid: true,
      promo: {
        code: promo.code,
        original_price: promo.original_price,
        promo_price: promo.promo_price,
        discount_amount: promo.discount_amount,
      },
    });
  } catch (error) {
    console.error("Promo validate error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}
