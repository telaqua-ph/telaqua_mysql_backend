import { getShipwayConfig } from "../config/shipwayConfig.js";
import { isCodOrder } from "./paymentMode.js";

const DEFAULT_PRODUCT_SKU = "telaqua-ph-meter";

const text = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const splitName = (name) => {
  const parts = text(name).split(" ").filter(Boolean);
  return { first: parts.shift() || "Customer", last: parts.join(" ") || "." };
};

/** Build Shipway v2orders payload solely from stored order data and product defaults. */
export function buildShipwayPayload(order, product) {
  const config = getShipwayConfig();
  const quantity = Math.max(1, Number(order.quantity) || 1);
  const total = Number(order.final_total ?? order.total_amount);
  const unitPrice = Number(order.unit_price);
  const { first, last } = splitName(order.customer_name);
  const mandatory = {
    order_id: text(order.order_number || order.id), customer_name: text(order.customer_name),
    shipping_phone: text(order.phone), shipping_address: text(order.address), shipping_city: text(order.city),
    shipping_state: text(order.state), shipping_zipcode: text(order.pincode),
  };
  if (!mandatory.order_id || !mandatory.customer_name || !mandatory.shipping_phone || !mandatory.shipping_address ||
      !mandatory.shipping_city || !mandatory.shipping_state || !/^\d{6}$/.test(mandatory.shipping_zipcode) ||
      !Number.isFinite(total) || total <= 0) {
    const error = new Error("Order is missing valid shipping or pricing details required by Shipway.");
    error.code = "SHIPWAY_ORDER_DATA_INVALID";
    throw error;
  }
  const weight = Number(product?.weightGm);
  const length = Number(product?.lengthCm);
  const breadth = Number(product?.widthCm);
  const height = Number(product?.heightCm);
  if (![weight, length, breadth, height].every((value) => Number.isFinite(value) && value > 0)) {
    const error = new Error("Tel-Aqua product weight and dimensions must be configured before booking with Shipway.");
    error.code = "SHIPWAY_ORDER_DATA_INVALID";
    throw error;
  }
  const payload = {
    order_id: mandatory.order_id,
    warehouse_id: config.warehouseId,
    return_warehouse_id: config.returnWarehouseId,
    products: [{
      product: text(product.name) || "Tel-Aqua Product",
      product_code: text(process.env.TELAQUA_PRODUCT_SKU) || DEFAULT_PRODUCT_SKU,
      product_quantity: String(quantity),
      price: String(Number.isFinite(unitPrice) && unitPrice > 0 ? unitPrice : total / quantity),
      discount: "0",
    }],
    payment_type: isCodOrder(order) ? "C" : "P",
    order_total: String(total),
    shipping_firstname: first,
    shipping_lastname: last,
    shipping_address: mandatory.shipping_address,
    shipping_city: mandatory.shipping_city,
    shipping_state: mandatory.shipping_state,
    shipping_country: "IN",
    shipping_phone: mandatory.shipping_phone,
    shipping_zipcode: mandatory.shipping_zipcode,
    order_weight: String(weight * quantity),
    box_length: String(length),
    box_breadth: String(breadth),
    box_height: String(height),
    order_date: new Date(order.created_at || Date.now()).toISOString().slice(0, 19).replace("T", " "),
  };
  const email = text(order.email);
  if (email) payload.email = email;
  // Deliberately omit carrier_id. Shipway selects the serviceable courier from
  // the dashboard's Courier Priority / Auto Assignment configuration.
  return payload;
}
