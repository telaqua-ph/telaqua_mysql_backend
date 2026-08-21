const OPERATIONS = Object.freeze({
  pincode: "PINCODE_URL",
  tat: "TAT_URL",
  waybill: "WAYBILL_URL",
  rate: "RATE_URL",
  warehouseCreate: "WAREHOUSE_CREATE_URL",
  shipmentCreate: "SHIPMENT_CREATE_URL",
  shipmentUpdate: "SHIPMENT_UPDATE_URL",
  tracking: "TRACKING_URL",
  label: "LABEL_URL",
  pickup: "PICKUP_URL",
  ndr: "NDR_URL",
});

function configError(message) {
  const error = new Error(message);
  error.code = "DELHIVERY_CONFIG_ERROR";
  return error;
}

export function getDelhiveryEnvironment() {
  const value = String(process.env.DELHIVERY_ENV || "staging")
    .trim()
    .toLowerCase();
  if (!['staging', 'production'].includes(value)) {
    throw configError('DELHIVERY_ENV must be "staging" or "production"');
  }
  return value;
}

export function getDelhiveryToken() {
  const token = String(process.env.DELHIVERY_API_TOKEN || "")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
  if (!token) throw configError("DELHIVERY_API_TOKEN is not configured");
  return token;
}

export function getDelhiveryUrl(operation) {
  const suffix = OPERATIONS[operation];
  if (!suffix) throw configError(`Unknown Delhivery operation: ${operation}`);
  const environment = getDelhiveryEnvironment();
  const key = `DELHIVERY_${environment.toUpperCase()}_${suffix}`;
  const value = String(process.env[key] || "").trim();
  if (!value) throw configError(`${key} is not configured`);
  try {
    return { environment, key, url: new URL(value).toString() };
  } catch {
    throw configError(`${key} must be a valid URL`);
  }
}

function envText(name, required = true) {
  const value = String(process.env[name] || "").replace(/\s+/g, " ").trim();
  if (required && !value) throw configError(`${name} is not configured`);
  return value;
}

export function getTelaquaWarehouse() {
  const pincode = envText("TELAQUA_WAREHOUSE_PINCODE");
  if (!/^\d{6}$/.test(pincode)) {
    throw configError("TELAQUA_WAREHOUSE_PINCODE must be a 6 digit pincode");
  }
  return {
    name: envText("TELAQUA_WAREHOUSE_NAME"),
    address: envText("TELAQUA_WAREHOUSE_ADDRESS"),
    city: envText("TELAQUA_WAREHOUSE_CITY"),
    state: envText("TELAQUA_WAREHOUSE_STATE"),
    pincode,
    phone: envText("TELAQUA_WAREHOUSE_PHONE"),
  };
}

export function getTelaquaProductDefaults() {
  const weightGm = Number(process.env.TELAQUA_PRODUCT_WEIGHT_GM);
  if (!Number.isFinite(weightGm) || weightGm <= 0) {
    throw configError("TELAQUA_PRODUCT_WEIGHT_GM must be a positive number");
  }
  return {
    name: envText("TELAQUA_PRODUCT_NAME"),
    weightGm: Math.round(weightGm),
  };
}

export function getSafeDelhiveryConfig() {
  const environment = getDelhiveryEnvironment();
  let warehouse = null;
  try {
    warehouse = getTelaquaWarehouse();
  } catch {
    // The read-only admin endpoint reports missing configuration separately.
  }
  return { environment, warehouse };
}

export { OPERATIONS as DELHIVERY_OPERATIONS };
