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
  if (!Number.isFinite(total) || total <= 0 || !text(order.address) || !/^\d{6}$/.test(text(order.pincode))) {
    const error = new Error("Order is missing valid shipping or pricing details required by Shipway.");
    error.code = "SHIPWAY_ORDER_DATA_INVALID";
    throw error;
  }
  if (!Number.isFinite(product?.weightGm) || product.weightGm <= 0 || !product?.lengthCm || !product?.widthCm || !product?.heightCm) {
    const error = new Error("Tel-Aqua product weight and dimensions must be configured before booking with Shipway.");
    error.code = "SHIPWAY_ORDER_DATA_INVALID";
    throw error;
  }
  return {
    order_id: text(order.order_number || order.id),
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
    email: text(order.email) || undefined,
    order_total: String(total),
    shipping_firstname: first,
    shipping_lastname: last,
    shipping_address: text(order.address),
    shipping_city: text(order.city),
    shipping_state: text(order.state),
    shipping_country: "IN",
    shipping_phone: text(order.phone),
    shipping_zipcode: text(order.pincode),
    order_weight: String(product.weightGm * quantity),
    box_length: String(product.lengthCm),
    box_breadth: String(product.widthCm),
    box_height: String(product.heightCm),
    order_date: new Date(order.created_at || Date.now()).toISOString().slice(0, 19).replace("T", " "),
  };
}
