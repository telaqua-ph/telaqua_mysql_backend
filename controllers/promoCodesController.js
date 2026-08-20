/**
 * controllers/promoCodesController.js
 *
 * Admin promo code management — CRUD on existing promo_codes table.
 * All handlers expect requireAuth (admin JWT).
 */

import {
  normalizePromoCode,
  mapPromoRecord,
  listPromoCodes,
  findPromoById,
  createPromoCode,
  updatePromoCode,
  updatePromoCodeStatus,
  promoCodeExists,
} from "../services/promoService.js";
import { parsePromoValidityRange } from "../utils/promoValidity.js";

function trimStr(value) {
  return typeof value === "string" ? value.trim() : value;
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function toAdminPromo(rowOrMapped) {
  const p =
    rowOrMapped && rowOrMapped.effective_status !== undefined
      ? rowOrMapped
      : mapPromoRecord(rowOrMapped);

  return {
    id: p.id,
    platform: p.platform,
    language: p.language,
    code: p.code,
    original_price: p.original_price,
    promo_price: p.promo_price,
    is_active: p.is_active,
    usage_limit: p.usage_limit,
    used_count: p.used_count,
    created_at: p.created_at,
    updated_at: p.updated_at,
    valid_from: p.valid_from ?? null,
    valid_until: p.valid_until ?? null,
    effective_status: p.effective_status,
  };
}

/**
 * Validate create/update payload fields (shared rules).
 * @param {object} body
 * @param {{ requireIsActive?: boolean }} options
 */
function validatePromoPayload(body, options = {}) {
  if (!body || typeof body !== "object") {
    return { error: "Invalid JSON body" };
  }

  const platform = trimStr(body.platform);
  const languageRaw = body.language;
  const language =
    languageRaw === undefined || languageRaw === null
      ? ""
      : trimStr(String(languageRaw));
  const code = normalizePromoCode(body.code);
  const original_price = Number(body.original_price);
  const promo_price = Number(body.promo_price);

  if (!platform) {
    return { error: "platform is required" };
  }
  if (!code) {
    return { error: "code is required" };
  }
  if (
    body.original_price === undefined ||
    body.original_price === null ||
    body.original_price === ""
  ) {
    return { error: "original_price is required" };
  }
  if (!Number.isFinite(original_price) || original_price <= 0) {
    return { error: "original_price must be greater than 0" };
  }
  if (
    body.promo_price === undefined ||
    body.promo_price === null ||
    body.promo_price === ""
  ) {
    return { error: "promo_price is required" };
  }
  if (!Number.isFinite(promo_price) || promo_price < 0) {
    return { error: "promo_price must be greater than or equal to 0" };
  }
  if (promo_price > original_price) {
    return { error: "promo_price must be less than or equal to original_price" };
  }

  let is_active = true;
  if (options.requireIsActive) {
    if (typeof body.is_active !== "boolean") {
      return { error: "is_active must be a boolean" };
    }
    is_active = body.is_active;
  } else if (body.is_active !== undefined) {
    // PUT may optionally include is_active — ignore for update of editable fields only
  }

  let usage_limit = null;
  if (body.usage_limit !== undefined && body.usage_limit !== null && body.usage_limit !== "") {
    const limit = Number(body.usage_limit);
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
      return { error: "usage_limit must be a positive integer or null" };
    }
    usage_limit = limit;
  }

  const validity = parsePromoValidityRange(body.valid_from, body.valid_until);
  if (!validity.ok) {
    return { error: validity.error };
  }

  return {
    data: {
      platform,
      language,
      code,
      original_price,
      promo_price,
      is_active,
      usage_limit,
      valid_from: validity.valid_from,
      valid_until: validity.valid_until,
    },
  };
}

/** POST /api/promo-codes */
export async function createPromoCodeHandler(req, res) {
  try {
    const validation = validatePromoPayload(req.body, { requireIsActive: true });
    if (validation.error) {
      return res.status(400).json({
        success: false,
        message: validation.error,
      });
    }

    const data = validation.data;

    if (await promoCodeExists(data.code)) {
      return res.status(409).json({
        success: false,
        message: "Promo code already exists",
      });
    }

    const row = await createPromoCode(data);
    const promoCode = toAdminPromo(mapPromoRecord(row));

    return res.status(201).json({
      success: true,
      message: "Promo code created successfully",
      promoCode,
    });
  } catch (error) {
    console.error("Create promo code error:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** GET /api/promo-codes */
export async function listPromoCodesHandler(req, res) {
  try {
    const statusRaw = String(req.query.status ?? "").trim().toLowerCase();
    let status;
    if (statusRaw === "active" || statusRaw === "inactive") {
      status = statusRaw;
    } else if (statusRaw) {
      return res.status(400).json({
        success: false,
        message: "status must be active or inactive",
      });
    }

    const rows = await listPromoCodes(status);
    const promoCodes = rows.map((row) => toAdminPromo(mapPromoRecord(row)));

    return res.status(200).json({
      success: true,
      promoCodes,
    });
  } catch (error) {
    console.error("List promo codes error:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** GET /api/promo-codes/:id */
export async function getPromoCodeHandler(req, res) {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invalid promo code id",
      });
    }

    const row = await findPromoById(id);
    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Promo code not found",
      });
    }

    const p = mapPromoRecord(row);
    return res.status(200).json({
      success: true,
      promoCode: toAdminPromo(p),
    });
  } catch (error) {
    console.error("Get promo code error:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** PUT /api/promo-codes/:id */
export async function updatePromoCodeHandler(req, res) {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invalid promo code id",
      });
    }

    const existing = await findPromoById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Promo code not found",
      });
    }

    const validation = validatePromoPayload(req.body, { requireIsActive: false });
    if (validation.error) {
      return res.status(400).json({
        success: false,
        message: validation.error,
      });
    }

    const data = validation.data;

    if (await promoCodeExists(data.code, id)) {
      return res.status(409).json({
        success: false,
        message: "Promo code already exists",
      });
    }

    const row = await updatePromoCode(id, data);
    const p = mapPromoRecord(row);

    return res.status(200).json({
      success: true,
      message: "Promo code updated successfully",
      promoCode: toAdminPromo(p),
    });
  } catch (error) {
    console.error("Update promo code error:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** PATCH /api/promo-codes/:id/status */
export async function updatePromoCodeStatusHandler(req, res) {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invalid promo code id",
      });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (typeof body.is_active !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "is_active must be a boolean",
      });
    }

    const existing = await findPromoById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Promo code not found",
      });
    }

    const row = await updatePromoCodeStatus(id, body.is_active);
    const p = mapPromoRecord(row);

    return res.status(200).json({
      success: true,
      message: "Promo code status updated successfully",
      promoCode: toAdminPromo(p),
    });
  } catch (error) {
    console.error("Update promo status error:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}
