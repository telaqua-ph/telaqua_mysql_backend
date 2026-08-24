/**
 * controllers/deliveryController.js
 *
 * Delhivery delivery / logistics endpoints (not payment):
 * - Pincode serviceability, TAT, waybill, rate, warehouse
 * - Shipment create / update
 * - Pickup, tracking, NDR
 * See docs/DELHIVERY_FLOW.md
 */

import {
  checkPincodeServiceability,
  getExpectedTat,
  getWaybills,
  getShippingRate,
  createClientWarehouse,
  createShipment,
  updateShipment,
  trackShipment,
  requestPickup,
  updateNdr,
} from "../services/delhiveryService.js";
import { isMissingColumnError } from "../lib/dbErrors.js";
import { query } from "../config/db.js";

/** Sensible upper bound for bulk waybill requests. */
const MAX_WAYBILL_COUNT = 100;

/** Max chargeable weight in grams (50 kg). */
const MAX_CGM = 50000;

const ALLOWED_MD = ["E", "S"];
/** Delhivery Invoice Charge API: Delivered, RTO, DTO only. */
const ALLOWED_SS = ["Delivered", "RTO", "DTO"];

/** Exact Client Warehouse Create fields allowed by Delhivery. */
const WAREHOUSE_FIELDS = [
  "name",
  "registered_name",
  "address",
  "city",
  "pin",
  "phone",
  "email",
  "country",
  "return_address",
  "return_pin",
  "return_city",
  "return_state",
  "return_country",
];

/** Delhivery Edit Order API — keys that can be updated (besides required waybill). */
const SHIPMENT_UPDATE_OPTIONAL_FIELDS = [
  "name",
  "add",
  "phone",
  "cod",
  "gm",
  "shipment_length",
  "shipment_width",
  "shipment_height",
  "product_details",
  "pt",
];

const ALLOWED_PAYMENT_MODES_PT = ["COD", "Pre-paid", "Prepaid", "Pickup"];

/** Delhivery NDR Update API — allowed act values. */
const NDR_ACTIONS = ["RE-ATTEMPT", "DEFER_DLV", "EDIT_DETAILS"];

/** Delhivery rejects these characters in CMU payloads unless JSON-escaped carefully. */
const DELHIVERY_FORBIDDEN_CHARS = /[&#%;\\]/g;

/**
 * Map Delhivery service errors to HTTP responses.
 * Never exposes tokens or stack traces.
 */
function handleDelhiveryError(res, error, contextLabel) {
  console.error(`${contextLabel} error:`, {
    code: error?.code,
    status: error?.status,
    message: error?.message,
  });

  if (error?.code === "DELHIVERY_CONFIG_ERROR") {
    return res.status(500).json({
      success: false,
      message: error.message || "Delhivery is not configured",
    });
  }

  if (error?.code === "DELHIVERY_TIMEOUT") {
    return res.status(504).json({
      success: false,
      message: "Delhivery request timed out. Please try again.",
    });
  }

  if (error?.code === "ORDERS_COLUMN_MISSING" || error?.code === "AWB_SAVE_FAILED") {
    return res.status(500).json({
      success: false,
      message: error.message || "Cannot save AWB on the existing orders row",
      ...(error.awb ? { awb: error.awb, waybill: error.awb } : {}),
    });
  }

  if (error?.code === "DELHIVERY_NETWORK_ERROR") {
    return res.status(502).json({
      success: false,
      message: "Delhivery service is currently unavailable",
    });
  }

  if (error?.code === "DELHIVERY_INVALID_RESPONSE") {
    return res.status(502).json({
      success: false,
      message: "Delhivery returned an invalid or unexpected response",
    });
  }

  if (error?.code === "DELHIVERY_UPSTREAM_ERROR") {
    const status = error.status;
    const upstreamMessage =
      typeof error.message === "string" &&
      error.message &&
      !error.message.startsWith("Delhivery API returned HTTP")
        ? error.message
        : null;

    if (status === 401) {
      return res.status(401).json({
        success: false,
        message: upstreamMessage || "Delhivery authentication failed",
      });
    }

    if (status === 403) {
      return res.status(403).json({
        success: false,
        message: "Delhivery permission denied",
      });
    }

    if (status === 404) {
      return res.status(404).json({
        success: false,
        message: "Delhivery route or resource is unavailable",
      });
    }

    if (status === 409) {
      return res.status(409).json({
        success: false,
        message: upstreamMessage || "Conflict with existing Delhivery resource",
        ...(error.upstreamBody ? { data: error.upstreamBody } : {}),
      });
    }

    if (status === 429) {
      return res.status(429).json({
        success: false,
        message: "Delhivery rate limit exceeded. Please try again later.",
      });
    }

    if (status === 422) {
      return res.status(422).json({
        success: false,
        message: upstreamMessage || "Invalid shipment payload for Delhivery",
        ...(error.upstreamBody ? { data: error.upstreamBody } : {}),
      });
    }

    if (status === 400) {
      const msg = (
        upstreamMessage ||
        JSON.stringify(error.upstreamBody || {})
      ).toLowerCase();
      const looksLikeDuplicate =
        msg.includes("already exists") ||
        msg.includes("already exist") ||
        msg.includes("duplicate");

      if (looksLikeDuplicate) {
        return res.status(409).json({
          success: false,
          message: upstreamMessage || "Resource already exists in Delhivery",
          ...(error.upstreamBody ? { data: error.upstreamBody } : {}),
        });
      }

      return res.status(400).json({
        success: false,
        message: upstreamMessage || "Invalid data for Delhivery",
        ...(error.upstreamBody ? { data: error.upstreamBody } : {}),
      });
    }

    if (status >= 500) {
      return res.status(502).json({
        success: false,
        message: upstreamMessage || "Delhivery service is currently unavailable",
      });
    }

    return res.status(502).json({
      success: false,
      message: upstreamMessage || "Unable to complete Delhivery request",
    });
  }

  return res.status(500).json({
    success: false,
    message: "Internal server error",
  });
}

function sanitizeDelhiveryText(value) {
  return String(value ?? "")
    .replace(DELHIVERY_FORBIDDEN_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map Telaqua payment_method to Delhivery payment_mode.
 * Docs: COD or Pre-paid for forward shipments.
 * @param {string} paymentMethod
 * @returns {"COD"|"Pre-paid"|null}
 */
function mapPaymentMode(paymentMethod) {
  const method = String(paymentMethod || "").trim().toLowerCase();
  if (!method) return null;

  if (
    method === "cod" ||
    method === "cash on delivery" ||
    method === "cash_on_delivery"
  ) {
    return "COD";
  }

  if (
    method === "razorpay" ||
    method === "prepaid" ||
    method === "pre-paid" ||
    method === "online" ||
    method === "upi" ||
    method === "card" ||
    method === "netbanking" ||
    method === "wallet" ||
    method === "emi" ||
    method === "paylater"
  ) {
    return "Pre-paid";
  }

  return null;
}

function readEnvText(name) {
  return String(process.env[name] || "")
    .replace(/\r\n/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePositiveIntEnv(name) {
  const raw = (process.env[name] || "").trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Read required shipment config from env (pickup location name + product weight + dimensions).
 * Pickup location must already exist in Delhivery One.
 */
function getShipmentConfig() {
  const warehouseName = readEnvText("TELAQUA_WAREHOUSE_NAME");
  const warehouseAddress = readEnvText("TELAQUA_WAREHOUSE_ADDRESS");
  const warehouseCity = readEnvText("TELAQUA_WAREHOUSE_CITY");
  const warehouseState = readEnvText("TELAQUA_WAREHOUSE_STATE");
  const warehousePincode = readEnvText("TELAQUA_WAREHOUSE_PINCODE");
  const warehousePhone = readEnvText("TELAQUA_WAREHOUSE_PHONE");
  const productName = (
    process.env.TELAQUA_PRODUCT_NAME ||
    "Tel-Aqua Product"
  ).trim();
  const weightRaw = (process.env.TELAQUA_PRODUCT_WEIGHT_GM || "").trim();
  const lengthCm = parsePositiveIntEnv("TELAQUA_PRODUCT_LENGTH_CM");
  const widthCm = parsePositiveIntEnv("TELAQUA_PRODUCT_WIDTH_CM");
  const heightCm = parsePositiveIntEnv("TELAQUA_PRODUCT_HEIGHT_CM");

  if (!warehouseName) {
    return {
      ok: false,
      message:
        "TELAQUA_WAREHOUSE_NAME is not configured. Set it to the exact Delhivery warehouse/pickup location name.",
    };
  }

  if (!warehouseAddress) {
    return {
      ok: false,
      message:
        "TELAQUA_WAREHOUSE_ADDRESS is not configured. Set the full Tel-Aqua pickup/warehouse street address.",
    };
  }

  if (!weightRaw || !/^\d+$/.test(weightRaw) || Number(weightRaw) <= 0) {
    return {
      ok: false,
      message:
        "TELAQUA_PRODUCT_WEIGHT_GM is not configured. Set a positive integer package weight in grams before creating shipments.",
    };
  }

  const weightGm = Number(weightRaw);
  if (weightGm > MAX_CGM) {
    return {
      ok: false,
      message: `TELAQUA_PRODUCT_WEIGHT_GM cannot exceed ${MAX_CGM} grams`,
    };
  }

  if (lengthCm === null || widthCm === null || heightCm === null) {
    return {
      ok: false,
      message:
        "Actual Tel-Aqua package dimensions are not currently configured. Please provide Length × Width × Height.",
    };
  }

  return {
    ok: true,
    config: {
      warehouseName,
      productName: sanitizeDelhiveryText(productName) || "Tel-Aqua Product",
      weightGm,
      lengthCm,
      widthCm,
      heightCm,
      sellerName: (
        process.env.TELAQUA_BUSINESS_NAME ||
        "Tel-Aqua"
      ).trim(),
      warehousePhone,
      warehouseAddress,
      warehouseCity,
      warehouseState,
      warehousePincode,
    },
  };
}

function orderChargeAmount(order) {
  const n = Number(order.final_total ?? order.total_amount);
  return n;
}

function buildPickupLocation(config) {
  const pickup_location = {
    name: config.warehouseName,
    add: sanitizeDelhiveryText(config.warehouseAddress),
  };

  if (config.warehouseCity) {
    pickup_location.city = sanitizeDelhiveryText(config.warehouseCity);
  }
  if (config.warehousePincode && /^\d{6}$/.test(config.warehousePincode)) {
    pickup_location.pin = config.warehousePincode;
  }
  if (config.warehousePhone) {
    pickup_location.phone = config.warehousePhone;
  }
  pickup_location.country = "India";

  return pickup_location;
}

function buildShipmentPayload(order, config, paymentMode) {
  const totalAmount = orderChargeAmount(order);
  const quantity = Number(order.quantity);

  const shipment = {
    name: sanitizeDelhiveryText(order.customer_name),
    add: sanitizeDelhiveryText(order.address),
    pin: String(order.pincode).trim(),
    city: sanitizeDelhiveryText(order.city),
    state: sanitizeDelhiveryText(order.state),
    country: "India",
    phone: String(order.phone).trim(),
    order: String(order.order_number).trim(),
    payment_mode: paymentMode,
    products_desc: config.productName,
    quantity: String(quantity),
    total_amount: totalAmount,
    weight: `${config.weightGm}`,
    shipment_length: config.lengthCm,
    shipment_width: config.widthCm,
    shipment_height: config.heightCm,
  };

  if (paymentMode === "COD") {
    shipment.cod_amount = String(totalAmount);
  }

  if (config.sellerName) {
    shipment.seller_name = sanitizeDelhiveryText(config.sellerName);
  }
  if (config.warehouseAddress) {
    shipment.seller_add = sanitizeDelhiveryText(config.warehouseAddress);
  }

  if (
    config.warehouseAddress &&
    config.warehouseCity &&
    config.warehouseState &&
    config.warehousePincode &&
    /^\d{6}$/.test(config.warehousePincode)
  ) {
    shipment.return_add = sanitizeDelhiveryText(config.warehouseAddress);
    shipment.return_city = sanitizeDelhiveryText(config.warehouseCity);
    shipment.return_state = sanitizeDelhiveryText(config.warehouseState);
    shipment.return_pin = config.warehousePincode;
    shipment.return_country = "India";
    if (config.warehousePhone) {
      shipment.return_phone = config.warehousePhone;
    }
  }

  return {
    pickup_location: buildPickupLocation(config),
    shipments: [shipment],
  };
}

function looksLikeAwb(value) {
  const s = String(value ?? "").trim();
  return /^\d{8,20}$/.test(s);
}

function extractAwbFromDelhiveryResponse(data) {
  if (!data || typeof data !== "object") return null;
  const firstPkg = Array.isArray(data.packages) ? data.packages[0] : null;
  const candidates = [
    firstPkg?.waybill,
    firstPkg?.wbn,
    firstPkg?.awb,
    firstPkg?.AWB,
    data.waybill,
    data.wbn,
    data.awb,
    data.AWB,
    data.shipment?.waybill,
    data.shipment?.wbn,
  ];
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    if (looksLikeAwb(s)) return s;
  }
  return null;
}

function existingOrderAwb(order) {
  const candidates = [order?.waybill, order?.awb, order?.AWB];
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    if (looksLikeAwb(s)) return s;
  }
  return null;
}

function isOrderShipmentAlreadyCreated(order) {
  if (existingOrderAwb(order)) return true;
  const shipmentId = String(order?.delhivery_shipment_id || "").trim();
  if (shipmentId) return true;
  const status = String(order?.shipment_status || "")
    .trim()
    .toLowerCase();
  if (!status || status === "not created" || status.startsWith("not ")) {
    return false;
  }
  if (status.includes("fail") || status.includes("error")) return false;
  return status === "created" || status.includes("created");
}

function safeDelhiveryResponseSnapshot(data) {
  if (!data || typeof data !== "object") {
    return { type: typeof data };
  }
  const first = Array.isArray(data.packages) ? data.packages[0] : null;
  return {
    keys: Object.keys(data).slice(0, 20),
    package_count: data.package_count,
    success: data.success,
    rmk: data.rmk,
    message: data.message,
    waybill: data.waybill || null,
    wbn: data.wbn || null,
    upload_wbn: data.upload_wbn || null,
    packages_len: Array.isArray(data.packages) ? data.packages.length : 0,
    first_package_keys: first && typeof first === "object" ? Object.keys(first) : [],
    first_package_status: first?.status || null,
    first_package_waybill: first?.waybill || null,
    first_package_remarks: first?.remarks || first?.remark || null,
  };
}

/**
 * Interpret Delhivery CMU create.json responses (including HTTP 200 soft-failures).
 * Success requires a usable AWB. Never treat HTTP 200 alone as created.
 */
function interpretShipmentCreateResult(data) {
  if (!data || typeof data !== "object") {
    return {
      ok: false,
      status: 502,
      message: "Delhivery returned an invalid or unexpected response",
      waybill: null,
      shipmentId: null,
    };
  }

  const packages = Array.isArray(data.packages) ? data.packages : [];
  const first = packages[0] || {};
  const waybill = extractAwbFromDelhiveryResponse(data);
  const shipmentId =
    String(data.upload_wbn || data.shipment_id || "").trim() || null;
  const packageRemarks = packages
    .map((pkg) => pkg?.remarks || pkg?.remark || pkg?.status)
    .filter(Boolean)
    .join("; ");
  const combined = `${data.rmk || ""} ${packageRemarks} ${
    typeof data.error === "string" ? data.error : ""
  }`.toLowerCase();
  const looksDuplicate =
    combined.includes("duplicate") ||
    combined.includes("already exists") ||
    combined.includes("already exist");
  const pkgStatus = String(first.status || "").toLowerCase();
  const failedPkg = packages.find((pkg) => {
    const status = String(pkg?.status || "").toLowerCase();
    const remarks = String(pkg?.remarks || pkg?.remark || "").toLowerCase();
    return (
      status === "fail" ||
      status === "failed" ||
      remarks.includes("fail")
    );
  });
  const successFlag =
    data.success === true ||
    data.success === "true" ||
    pkgStatus === "success" ||
    pkgStatus === "ok";

  if (waybill) {
    return { ok: true, waybill, shipmentId };
  }

  if (data.success === false || data.error === true || failedPkg) {
    const message =
      (failedPkg && (failedPkg.remarks || failedPkg.remark)) ||
      packageRemarks ||
      (typeof data.rmk === "string" && data.rmk) ||
      (typeof data.message === "string" && data.message) ||
      "Unable to create Delhivery shipment";
    return {
      ok: false,
      status: looksDuplicate ? 409 : 400,
      message,
      waybill: null,
      shipmentId,
    };
  }

  if (successFlag) {
    return {
      ok: false,
      status: 502,
      message: "Delhivery shipment succeeded but no AWB was returned.",
      waybill: null,
      shipmentId,
    };
  }

  return {
    ok: false,
    status: 502,
    message:
      packageRemarks ||
      (typeof data.rmk === "string" && data.rmk) ||
      "Delhivery did not return a waybill.",
    waybill: null,
    shipmentId,
  };
}

/**
 * Persist AWB on the SAME existing orders row. Never inserts a new order.
 * Does not change order_status (shipment created ≠ shipped).
 */
async function persistAwbOnOrder(orderId, { awb, shipmentId }) {
  let saved;
  try {
    await query(
      `UPDATE orders SET
         waybill = ?,
         shipment_status = 'Created',
         delhivery_shipment_id = COALESCE(?, delhivery_shipment_id),
         shipment_created_at = COALESCE(shipment_created_at, CURRENT_TIMESTAMP),
         shipment_error = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [awb, shipmentId || null, orderId]
    );
    const result = await query(
      `SELECT id, waybill, shipment_status, delhivery_shipment_id, shipment_created_at
       FROM orders WHERE id = ? LIMIT 1`,
      [orderId]
    );
    saved = result.rows[0];
  } catch (err) {
    if (isMissingColumnError(err)) {
      const missing = new Error(
        `Cannot save AWB: a required orders column is missing (${err.message}).`
      );
      missing.code = "ORDERS_COLUMN_MISSING";
      throw missing;
    }
    throw err;
  }

  try {
    await query(
      `UPDATE orders SET delivery_provider = 'Delhivery' WHERE id = ?`,
      [orderId]
    );
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
  }

  return saved;
}

async function recordShipmentError(orderId, message) {
  try {
    await query(
      `UPDATE orders SET
         shipment_error = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [orderId, String(message || "").slice(0, 1000)]
    );
  } catch {
    /* ignore missing column / db error */
  }
}

/**
 * POST /api/delhivery/shipment/create
 * Optional alias: POST /api/delhivery/create-shipment
 *
 * Creates a Delhivery shipment for an existing Telaqua order.
 * Loads the SAME orders row from Neon, then saves AWB onto that row.
 * Does not change order_status (Created ≠ Shipped).
 */
export async function createShipmentForOrder(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const rawOrderId = body.order_id ?? body.orderId;
    const hasOrderId =
      rawOrderId !== undefined &&
      rawOrderId !== null &&
      String(rawOrderId).trim() !== "";
    const hasOrderNumber =
      body.order_number !== undefined &&
      body.order_number !== null &&
      String(body.order_number).trim() !== "";

    if (!hasOrderId && !hasOrderNumber) {
      return res.status(400).json({
        success: false,
        message: "order_id or order_number is required",
      });
    }

    let order = null;

    if (hasOrderId) {
      const orderId = Number(rawOrderId);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).json({
          success: false,
          message: "order_id must be a positive integer",
        });
      }

      const { rows } = await query(`SELECT * FROM orders WHERE id = ?`, [
        orderId,
      ]);
      order = rows[0] || null;
    } else {
      const orderNumber = String(body.order_number).trim();
      const { rows } = await query(
        `SELECT * FROM orders WHERE order_number = ?`,
        [orderNumber]
      );
      order = rows[0] || null;
    }

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const alreadyAwb = existingOrderAwb(order);
    if (isOrderShipmentAlreadyCreated(order)) {
      return res.status(200).json({
        success: true,
        message: "Shipment already created",
        awb: alreadyAwb,
        waybill: alreadyAwb,
        order_id: order.id,
        order_number: order.order_number,
        shipment_status: order.shipment_status || "Created",
        delhivery_shipment_id: order.delhivery_shipment_id || null,
        shipment_created_at: order.shipment_created_at || null,
      });
    }

    const fail = async (status, message) => {
      await recordShipmentError(order.id, message);
      return res.status(status).json({
        success: false,
        message,
        order_id: order.id,
        order_number: order.order_number,
      });
    };

    if (!order.customer_name || !String(order.customer_name).trim()) {
      return fail(400, "Order is missing customer_name");
    }
    if (!order.phone || !String(order.phone).trim()) {
      return fail(400, "Order is missing phone");
    }
    if (!order.address || !String(order.address).trim()) {
      return fail(400, "Order is missing address");
    }
    if (!order.city || !String(order.city).trim()) {
      return fail(400, "Order is missing city");
    }
    if (!order.state || !String(order.state).trim()) {
      return fail(400, "Order is missing state");
    }
    if (!order.pincode || !/^\d{6}$/.test(String(order.pincode).trim())) {
      return fail(400, "Order pincode must be a valid 6-digit Indian pincode");
    }
    if (
      order.quantity === undefined ||
      order.quantity === null ||
      Number(order.quantity) <= 0
    ) {
      return fail(400, "Order quantity must be greater than 0");
    }
    const amount = orderChargeAmount(order);
    if (!Number.isFinite(amount) || amount <= 0) {
      return fail(400, "Order amount must be a valid number greater than 0");
    }
    if (!order.payment_method || !String(order.payment_method).trim()) {
      return fail(400, "Order is missing payment_method");
    }
    if (!order.order_number || !String(order.order_number).trim()) {
      return fail(400, "Order is missing order_number");
    }

    if (String(order.order_status || "").trim() === "Cancelled") {
      return fail(400, "Cannot create shipment for a cancelled order");
    }

    const paymentMode = mapPaymentMode(order.payment_method);
    if (!paymentMode) {
      return fail(
        400,
        `Unsupported payment_method for Delhivery: ${order.payment_method}`
      );
    }

    if (
      paymentMode === "Pre-paid" &&
      String(order.payment_status || "").trim() !== "Paid"
    ) {
      return fail(
        400,
        "Prepaid/Razorpay orders must have payment_status Paid before shipment creation"
      );
    }

    const configResult = getShipmentConfig();
    if (!configResult.ok) {
      return fail(500, configResult.message);
    }

    const payload = buildShipmentPayload(
      order,
      configResult.config,
      paymentMode
    );

    console.log("Delhivery shipment create request:", {
      order_id: order.id,
      order_number: order.order_number,
      pin: payload.shipments?.[0]?.pin,
      city: payload.shipments?.[0]?.city,
      state: payload.shipments?.[0]?.state,
      quantity: payload.shipments?.[0]?.quantity,
      payment_mode: payload.shipments?.[0]?.payment_mode,
      warehouse: payload.pickup_location?.name,
      warehouse_add: payload.pickup_location?.add || null,
      warehouse_city: payload.pickup_location?.city || null,
      warehouse_pin: payload.pickup_location?.pin || null,
      warehouse_phone: payload.pickup_location?.phone || null,
      weight: payload.shipments?.[0]?.weight,
      shipment_length: payload.shipments?.[0]?.shipment_length,
      shipment_width: payload.shipments?.[0]?.shipment_width,
      shipment_height: payload.shipments?.[0]?.shipment_height,
    });

    const data = await createShipment(payload);
    const interpreted = interpretShipmentCreateResult(data);

    if (!interpreted.ok) {
      console.error("Delhivery shipment create failed:", {
        order_id: order.id,
        message: interpreted.message,
        response: safeDelhiveryResponseSnapshot(data),
      });
      await recordShipmentError(order.id, interpreted.message);
      return res.status(interpreted.status).json({
        success: false,
        message: interpreted.message,
        order_id: order.id,
        order_number: order.order_number,
        data,
      });
    }

    const saved = await persistAwbOnOrder(order.id, {
      awb: interpreted.waybill,
      shipmentId: interpreted.shipmentId,
    }).catch((persistErr) => {
      console.error("Failed to save AWB on orders row:", {
        order_id: order.id,
        awb: interpreted.waybill,
        code: persistErr?.code,
        message: persistErr?.message,
      });
      const wrap = new Error(
        `Delhivery created AWB ${interpreted.waybill} but it could not be saved on the order. Do not click Send to Delhivery again.`
      );
      wrap.code = persistErr?.code || "AWB_SAVE_FAILED";
      wrap.status = 500;
      wrap.awb = interpreted.waybill;
      throw wrap;
    });

    return res.status(200).json({
      success: true,
      message: "Shipment created successfully",
      awb: saved?.waybill || interpreted.waybill,
      waybill: saved?.waybill || interpreted.waybill,
      order_id: order.id,
      order_number: order.order_number,
      shipment_status: saved?.shipment_status || "Created",
      delhivery_shipment_id:
        saved?.delhivery_shipment_id || interpreted.shipmentId,
      shipment_created_at: saved?.shipment_created_at,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery shipment create");
  }
}

/* ------------------------------------------------------------------ */
/* Additional logistics ops (serviceability → NDR). Payment untouched. */
/* ------------------------------------------------------------------ */

function requireStringField(body, field) {
  if (body[field] === undefined || body[field] === null) {
    return { ok: false, message: `${field} is required` };
  }
  const value = String(body[field]).trim();
  if (!value) {
    return { ok: false, message: `${field} is required` };
  }
  return { ok: true, value };
}

async function findOrderByIdOrWaybill({ orderId, waybill }) {
  if (orderId != null && String(orderId).trim() !== "") {
    const id = Number(orderId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const { rows } = await query(`SELECT * FROM orders WHERE id = ? LIMIT 1`, [
      id,
    ]);
    return rows[0] || null;
  }
  if (waybill) {
    const { rows } = await query(
      `SELECT * FROM orders WHERE waybill = ? LIMIT 1`,
      [String(waybill).trim()]
    );
    return rows[0] || null;
  }
  return null;
}

async function safeUpdateOrder(orderId, sql, params) {
  try {
    await query(sql, params);
    return true;
  } catch (err) {
    if (isMissingColumnError(err)) {
      console.warn("orders column missing for delivery update:", err.message);
      return false;
    }
    throw err;
  }
}

function extractTrackingStatus(data) {
  if (!data || typeof data !== "object") return null;
  const shipment = Array.isArray(data.ShipmentData)
    ? data.ShipmentData[0]
    : null;
  const details = shipment?.Shipment || shipment?.shipment || shipment || {};
  const status =
    details.Status?.Status ||
    details.Status?.StatusCode ||
    details.status ||
    details.Status ||
    data.status ||
    null;
  if (status == null) return null;
  return String(status).trim() || null;
}

/**
 * GET /api/delhivery/serviceability/:pincode
 */
export async function checkPincode(req, res) {
  try {
    const pincode = String(req.params.pincode ?? "").trim();
    if (!pincode || !/^\d{6}$/.test(pincode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid pincode. Pincode must be exactly 6 digits.",
      });
    }
    const data = await checkPincodeServiceability(pincode);
    return res.status(200).json({ success: true, pincode, data });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery serviceability");
  }
}

/**
 * GET /api/delhivery/tat
 */
export async function checkTat(req, res) {
  try {
    const origin_pin = String(req.query.origin_pin ?? "").trim();
    const destination_pin = String(req.query.destination_pin ?? "").trim();
    const motRaw = req.query.mot;
    const mot =
      motRaw === undefined || motRaw === null || String(motRaw).trim() === ""
        ? "S"
        : String(motRaw).trim().toUpperCase();

    if (!origin_pin || !/^\d{6}$/.test(origin_pin)) {
      return res.status(400).json({
        success: false,
        message: "Invalid origin_pin. origin_pin must be exactly 6 digits.",
      });
    }
    if (!destination_pin || !/^\d{6}$/.test(destination_pin)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid destination_pin. destination_pin must be exactly 6 digits.",
      });
    }

    const data = await getExpectedTat({ origin_pin, destination_pin, mot });
    return res.status(200).json({
      success: true,
      origin_pin,
      destination_pin,
      mot,
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery TAT");
  }
}

/**
 * GET /api/delhivery/waybill?count=
 */
export async function fetchWaybills(req, res) {
  try {
    const raw = req.query.count;
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return res.status(400).json({
        success: false,
        message: "count is required",
      });
    }
    const countStr = String(raw).trim();
    if (!/^\d+$/.test(countStr)) {
      return res.status(400).json({
        success: false,
        message: "count must be a positive integer",
      });
    }
    const count = Number(countStr);
    if (!Number.isInteger(count) || count <= 0) {
      return res.status(400).json({
        success: false,
        message: "count must be a positive integer greater than 0",
      });
    }
    if (count > MAX_WAYBILL_COUNT) {
      return res.status(400).json({
        success: false,
        message: `count cannot exceed ${MAX_WAYBILL_COUNT}`,
      });
    }
    const data = await getWaybills(count);
    return res.status(200).json({ success: true, count, data });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery waybill");
  }
}

/**
 * GET /api/delhivery/rate
 */
export async function calculateRate(req, res) {
  try {
    const md = String(req.query.md ?? "").trim().toUpperCase();
    const cgmRaw = String(req.query.cgm ?? "").trim();
    const o_pin = String(req.query.o_pin ?? "").trim();
    const d_pin = String(req.query.d_pin ?? "").trim();
    const ss = String(req.query.ss ?? "").trim();

    if (!md || !ALLOWED_MD.includes(md)) {
      return res.status(400).json({
        success: false,
        message: `Invalid md. Allowed values: ${ALLOWED_MD.join(", ")}`,
      });
    }
    if (!cgmRaw || !/^\d+$/.test(cgmRaw)) {
      return res.status(400).json({
        success: false,
        message: "cgm must be a positive integer (grams)",
      });
    }
    const cgm = Number(cgmRaw);
    if (!Number.isInteger(cgm) || cgm <= 0 || cgm > MAX_CGM) {
      return res.status(400).json({
        success: false,
        message: `cgm must be between 1 and ${MAX_CGM}`,
      });
    }
    if (!o_pin || !/^\d{6}$/.test(o_pin)) {
      return res.status(400).json({
        success: false,
        message: "Invalid o_pin. o_pin must be exactly 6 digits.",
      });
    }
    if (!d_pin || !/^\d{6}$/.test(d_pin)) {
      return res.status(400).json({
        success: false,
        message: "Invalid d_pin. d_pin must be exactly 6 digits.",
      });
    }
    if (!ss || !ALLOWED_SS.includes(ss)) {
      return res.status(400).json({
        success: false,
        message: `Invalid ss. Allowed values: ${ALLOWED_SS.join(", ")}`,
      });
    }

    const data = await getShippingRate({ md, cgm, o_pin, d_pin, ss });
    return res.status(200).json({
      success: true,
      md,
      cgm,
      o_pin,
      d_pin,
      ss,
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery rate");
  }
}

/**
 * POST /api/delhivery/warehouse/create
 */
export async function createWarehouse(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const payload = {};
    for (const field of WAREHOUSE_FIELDS) {
      const result = requireStringField(body, field);
      if (!result.ok) {
        return res.status(400).json({ success: false, message: result.message });
      }
      payload[field] = result.value;
    }
    if (!/^\d{6}$/.test(payload.pin) || !/^\d{6}$/.test(payload.return_pin)) {
      return res.status(400).json({
        success: false,
        message: "pin and return_pin must be exactly 6 digits",
      });
    }
    const phoneDigits = payload.phone.replace(/\D/g, "");
    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone. Provide a valid contact number.",
      });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    const data = await createClientWarehouse(payload);
    const dataMessage = String(
      data?.message || data?.msg || data?.error || ""
    ).toLowerCase();
    const indicatesFailure =
      data?.success === false ||
      data?.error === true ||
      dataMessage.includes("already") ||
      dataMessage.includes("exist") ||
      dataMessage.includes("fail");

    if (indicatesFailure) {
      const message =
        (typeof data?.message === "string" && data.message) ||
        (typeof data?.msg === "string" && data.msg) ||
        "Warehouse could not be created";
      const status =
        dataMessage.includes("already") || dataMessage.includes("exist")
          ? 409
          : 400;
      return res.status(status).json({ success: false, message, data });
    }

    return res.status(200).json({
      success: true,
      message: "Warehouse created successfully",
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery warehouse create");
  }
}

function buildShipmentUpdatePayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Invalid JSON body" };
  }
  const allowed = ["waybill", ...SHIPMENT_UPDATE_OPTIONAL_FIELDS];
  const unknownKeys = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      message: `Unsupported field(s): ${unknownKeys.join(", ")}. Allowed: ${allowed.join(", ")}`,
    };
  }
  const waybill = String(body.waybill ?? "").trim();
  if (!waybill) {
    return { ok: false, message: "waybill is required" };
  }
  if (!/^\d{8,20}$/.test(waybill)) {
    return {
      ok: false,
      message: "waybill must be an 8–20 digit Delhivery AWB number",
    };
  }
  const payload = { waybill };
  for (const field of SHIPMENT_UPDATE_OPTIONAL_FIELDS) {
    if (body[field] === undefined || body[field] === null) continue;
    const text = String(body[field]).trim();
    if (!text) continue;
    if (field === "pt" && !ALLOWED_PAYMENT_MODES_PT.includes(text)) {
      return {
        ok: false,
        message: `pt must be one of: ${ALLOWED_PAYMENT_MODES_PT.join(", ")}`,
      };
    }
    payload[field] =
      field === "name" || field === "add" || field === "product_details"
        ? sanitizeDelhiveryText(text)
        : text;
  }
  if (Object.keys(payload).length <= 1) {
    return {
      ok: false,
      message: "Provide at least one field to update besides waybill",
    };
  }
  return { ok: true, payload };
}

/**
 * POST /api/delhivery/shipment/update
 */
export async function updateShipmentDetails(req, res) {
  try {
    const built = buildShipmentUpdatePayload(req.body);
    if (!built.ok) {
      return res.status(400).json({ success: false, message: built.message });
    }
    const data = await updateShipment(built.payload);
    const dataMessage = String(
      data?.message || data?.msg || data?.error || data?.rmk || ""
    ).toLowerCase();
    const indicatesFailure =
      data?.success === false ||
      data?.error === true ||
      dataMessage.includes("fail") ||
      dataMessage.includes("invalid") ||
      dataMessage.includes("not found") ||
      dataMessage.includes("cannot");

    if (indicatesFailure) {
      const message =
        (typeof data?.message === "string" && data.message) ||
        (typeof data?.msg === "string" && data.msg) ||
        (typeof data?.rmk === "string" && data.rmk) ||
        "Unable to update Delhivery shipment";
      return res.status(400).json({
        success: false,
        message,
        waybill: built.payload.waybill,
        data,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Shipment updated successfully",
      waybill: built.payload.waybill,
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery shipment update");
  }
}

/**
 * POST /api/delhivery/tracking
 * Body: { waybill, order_id? }
 */
export async function trackShipmentStatus(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const waybill = String(body.waybill ?? "").trim();
    if (!waybill) {
      return res.status(400).json({
        success: false,
        message: "Waybill is required",
      });
    }
    if (!/^\d{8,20}$/.test(waybill)) {
      return res.status(400).json({
        success: false,
        message: "waybill must be an 8–20 digit Delhivery AWB number",
      });
    }

    const data = await trackShipment(waybill);
    const trackingStatus = extractTrackingStatus(data);

    const order = await findOrderByIdOrWaybill({
      orderId: body.order_id ?? body.orderId,
      waybill,
    });
    if (order?.id && trackingStatus) {
      await safeUpdateOrder(
        order.id,
        `UPDATE orders SET
           tracking_status = ?,
           tracking_updated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [trackingStatus.slice(0, 255), order.id]
      );
    }

    return res.status(200).json({
      success: true,
      message: "Shipment tracking fetched successfully",
      waybill,
      tracking_status: trackingStatus,
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery tracking");
  }
}

const PICKUP_REQUIRED_FIELDS = [
  "pickup_time",
  "pickup_date",
  "pickup_location",
  "expected_package_count",
];

function buildPickupPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Invalid JSON body" };
  }
  const allowed = [
    ...PICKUP_REQUIRED_FIELDS,
    "order_id",
    "orderId",
    "waybill",
    "force",
  ];
  const unknownKeys = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      message: `Unsupported field(s): ${unknownKeys.join(", ")}`,
    };
  }

  const pickup_time = String(body.pickup_time ?? "").trim();
  const pickup_date = String(body.pickup_date ?? "").trim();
  const pickup_location = String(body.pickup_location ?? "").trim();
  const countRaw = body.expected_package_count;

  if (!pickup_time || !/^\d{2}:\d{2}:\d{2}$/.test(pickup_time)) {
    return { ok: false, message: "pickup_time must be in HH:MM:SS format" };
  }
  if (!pickup_date || !/^\d{4}-\d{2}-\d{2}$/.test(pickup_date)) {
    return { ok: false, message: "pickup_date must be in YYYY-MM-DD format" };
  }
  if (!pickup_location) {
    return {
      ok: false,
      message:
        "pickup_location is required (exact registered Delhivery warehouse name)",
    };
  }
  if (
    countRaw === undefined ||
    countRaw === null ||
    String(countRaw).trim() === ""
  ) {
    return { ok: false, message: "expected_package_count is required" };
  }
  const countStr = String(countRaw).trim();
  if (!/^\d+$/.test(countStr)) {
    return {
      ok: false,
      message: "expected_package_count must be a positive integer",
    };
  }
  const expected_package_count = Number(countStr);
  if (!Number.isInteger(expected_package_count) || expected_package_count <= 0) {
    return {
      ok: false,
      message: "expected_package_count must be a positive integer greater than 0",
    };
  }

  return {
    ok: true,
    payload: {
      pickup_time,
      pickup_date,
      pickup_location,
      expected_package_count,
    },
    orderId: body.order_id ?? body.orderId,
    waybill: body.waybill,
    force: Boolean(body.force),
  };
}

/**
 * POST /api/delhivery/pickup
 */
export async function createPickupRequest(req, res) {
  try {
    const built = buildPickupPayload(req.body);
    if (!built.ok) {
      return res.status(400).json({ success: false, message: built.message });
    }

    const order = await findOrderByIdOrWaybill({
      orderId: built.orderId,
      waybill: built.waybill,
    });
    if (order) {
      const existing = String(order.pickup_status || "").toLowerCase();
      if (existing.includes("request") && !built.force) {
        return res.status(200).json({
          success: true,
          message: "Pickup already requested for this order.",
          already_requested: true,
          order_id: order.id,
          pickup_status: order.pickup_status,
          pickup_requested_at: order.pickup_requested_at || null,
        });
      }
    }

    const data = await requestPickup(built.payload);
    const pickupRef =
      data?.pickup_id ||
      data?.pickupId ||
      data?.request_id ||
      data?.data?.pickup_id ||
      null;

    if (order?.id) {
      await safeUpdateOrder(
        order.id,
        `UPDATE orders SET
           pickup_status = 'Requested',
           pickup_requested_at = COALESCE(pickup_requested_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [order.id]
      );
    }

    return res.status(200).json({
      success: true,
      message: "Pickup request submitted successfully",
      pickup_reference: pickupRef,
      order_id: order?.id || null,
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery pickup");
  }
}

const NDR_EDIT_DETAIL_FIELDS = ["name", "phone", "add"];

function validateNdrItem(item, index) {
  const label = `data[${index}]`;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { ok: false, message: `${label} must be an object` };
  }
  const waybill = String(item.waybill ?? "").trim();
  if (!waybill || !/^\d{8,20}$/.test(waybill)) {
    return {
      ok: false,
      message: `${label}.waybill must be an 8–20 digit Delhivery AWB number`,
    };
  }
  const act = String(item.act ?? "").trim();
  if (!NDR_ACTIONS.includes(act)) {
    return {
      ok: false,
      message: `${label}.act must be one of: ${NDR_ACTIONS.join(", ")}`,
    };
  }
  const value = { waybill, act };

  if (act === "RE-ATTEMPT") {
    return { ok: true, value };
  }

  if (act === "DEFER_DLV") {
    const deferred_date = String(item.action_data?.deferred_date ?? "").trim();
    if (!deferred_date || !/^\d{4}-\d{2}-\d{2}$/.test(deferred_date)) {
      return {
        ok: false,
        message: `${label}.action_data.deferred_date is required (YYYY-MM-DD)`,
      };
    }
    value.action_data = { deferred_date };
    return { ok: true, value };
  }

  const actionData = item.action_data;
  if (!actionData || typeof actionData !== "object") {
    return {
      ok: false,
      message: `${label}.action_data is required for EDIT_DETAILS`,
    };
  }
  const cleaned = {};
  for (const field of NDR_EDIT_DETAIL_FIELDS) {
    if (actionData[field] !== undefined && actionData[field] !== null) {
      const text = sanitizeDelhiveryText(actionData[field]);
      if (text) {
        cleaned[field] =
          field === "phone" ? String(actionData[field]).trim() : text;
      }
    }
  }
  if (!Object.keys(cleaned).length) {
    return {
      ok: false,
      message: `${label}.action_data must include at least one of: ${NDR_EDIT_DETAIL_FIELDS.join(", ")}`,
    };
  }
  value.action_data = cleaned;
  return { ok: true, value };
}

/**
 * POST /api/delhivery/ndr
 * Body: { data: [ { waybill, act, action_data? } ], order_id? }
 */
export async function updateNdrAction(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (!Array.isArray(body.data) || body.data.length === 0) {
      return res.status(400).json({
        success: false,
        message: "data must be a non-empty array of NDR actions",
      });
    }

    const validated = [];
    for (let i = 0; i < body.data.length; i += 1) {
      const result = validateNdrItem(body.data[i], i);
      if (!result.ok) {
        return res.status(400).json({ success: false, message: result.message });
      }
      validated.push(result.value);
    }

    const data = await updateNdr({ data: validated });
    const first = validated[0];
    const order = await findOrderByIdOrWaybill({
      orderId: body.order_id ?? body.orderId,
      waybill: first?.waybill,
    });
    if (order?.id) {
      await safeUpdateOrder(
        order.id,
        `UPDATE orders SET
           tracking_status = ?,
           shipment_status = 'NDR',
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [`NDR:${first.act}`.slice(0, 255), order.id]
      );
    }

    return res.status(200).json({
      success: true,
      message: "NDR action submitted successfully",
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery NDR");
  }
}
