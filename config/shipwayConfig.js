const positiveId = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    const error = new Error(`${name} must be a positive numeric Shipway warehouse ID`);
    error.code = "SHIPWAY_CONFIG_ERROR";
    throw error;
  }
  return value;
};

const credential = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    const error = new Error(`${name} is not configured`);
    error.code = "SHIPWAY_CONFIG_ERROR";
    throw error;
  }
  return value;
};

/** Server-only Shipway configuration. Never return or log these credentials. */
export function getShipwayConfig() {
  return {
    email: credential("SHIPWAY_EMAIL"),
    licenseKey: credential("SHIPWAY_LICENSE_KEY"),
    warehouseId: positiveId("SHIPWAY_WAREHOUSE_ID"),
    returnWarehouseId: positiveId("SHIPWAY_RETURN_WAREHOUSE_ID"),
  };
}
