/**
 * controllers/deliveryController.js
 *
 * Delhivery shipment creation only (CMU create.json).
 * Pickup / Ready for Pickup / labels / tracking happen in Delhivery One.
 * See docs/DELHIVERY_FLOW.md
 */

import { createShipment } from "../services/delhiveryService.js";
import { isMissingColumnError } from "../lib/dbErrors.js";
import { query } from "../config/db.js";

/** Max chargeable weight in grams (50 kg). */
const MAX_CGM = 50000;

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
