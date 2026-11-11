/**
 * Delhivery create-shipment payload for Admin Create Shipment.
 * Product/package field names match controllers/deliveryController.js.
 * Razorpay vs COD differs only by payment_mode and cod_amount.
 */

import { DELHIVERY_SHIPPING_MODE } from "../config/delhiveryConfig.js";
import { codCollectableAmount } from "../lib/codPartialPayment.js";

const clean = (value) =>
  String(value ?? "")
    .replace(/[&#%;\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function paymentModeOf(order) {
  const pay = String(order?.payment_status || "").trim().toLowerCase();
  const offlineSold = String(order?.offline_sold || "").trim().toLowerCase();
  if (pay === "paid" || offlineSold.startsWith("cod paid")) return "Pre-paid";
  return /cod|cash/i.test(String(order?.payment_method || "")) ? "COD" : "Pre-paid";
}

export function buildShipmentPayload(order, shipment, warehouse, product) {
  const quantity = Math.max(1, Number(order.quantity) || 1);
  const paymentMode = paymentModeOf(order);
  const totalAmount = Number(order.final_total ?? order.total_amount);
  const item = {
    name: clean(order.customer_name),
    add: clean(order.address),
    city: clean(order.city),
    state: clean(order.state),
    pin: String(order.pincode),
    country: "India",
    phone: String(order.phone),
    order: String(order.order_number || order.id),
    payment_mode: paymentMode,
    shipping_mode: DELHIVERY_SHIPPING_MODE,
    products_desc: clean(product?.name) || "Tel-Aqua Product",
    quantity: String(quantity),
    total_amount: totalAmount,
    weight: String(product.weightGm * quantity),
    waybill: shipment.waybill_number,
  };

  if (product?.lengthCm != null) item.shipment_length = product.lengthCm;
  if (product?.widthCm != null) item.shipment_width = product.widthCm;
  if (product?.heightCm != null) item.shipment_height = product.heightCm;

  const sellerName = clean(product?.sellerName);
  if (sellerName) item.seller_name = sellerName;
  const sellerAdd = clean(warehouse?.address);
  if (sellerAdd) item.seller_add = sellerAdd;

  if (
    warehouse?.address &&
    warehouse?.city &&
    warehouse?.state &&
    warehouse?.pincode
  ) {
    item.return_add = clean(warehouse.address);
    item.return_city = clean(warehouse.city);
    item.return_state = clean(warehouse.state);
    item.return_pin = String(warehouse.pincode);
    item.return_country = "India";
    if (warehouse.phone) item.return_phone = String(warehouse.phone);
  }

  if (order.email) item.email = String(order.email);
  // COD: collect only the balance (₹199 partial payment already paid online).
  if (paymentMode === "COD") item.cod_amount = String(codCollectableAmount(order));

  return {
    pickup_location: {
      name: warehouse.name,
      add: warehouse.address,
      city: warehouse.city,
      state: warehouse.state,
      pin: warehouse.pincode,
      phone: warehouse.phone,
      country: "India",
    },
    shipments: [item],
  };
}
