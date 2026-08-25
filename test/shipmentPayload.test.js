import assert from "node:assert/strict";
import test from "node:test";

import { getTelaquaProductDefaults } from "../config/delhiveryConfig.js";
import { buildShipmentPayload } from "../services/shipmentPayload.js";

const warehouse = {
  name: "warehouse",
  address: "Madhapur",
  city: "Hyderabad",
  state: "Telangana",
  pincode: "500081",
  phone: "9876543210",
};

const product = {
  name: "Tel-Aqua Product",
  weightGm: 300,
  lengthCm: 15,
  widthCm: 10,
  heightCm: 5,
  sellerName: "Tel-Aqua",
};

const shipment = { waybill_number: "61112610001116" };

const prepaidOrder = {
  id: 368,
  order_number: "TAQ-000368",
  customer_name: "Lokesh",
  address: "Nellore",
  city: "Nellore",
  state: "Andhra Pradesh",
  pincode: "524127",
  phone: "9876543210",
  quantity: 1,
  total_amount: 1898,
  payment_method: "upi",
};

const codOrder = {
  ...prepaidOrder,
  id: 369,
  order_number: "TAQ-000369",
  payment_method: "cod",
};

test("getTelaquaProductDefaults reads Hostinger length/width/height env keys", () => {
  const saved = {
    name: process.env.TELAQUA_PRODUCT_NAME,
    weight: process.env.TELAQUA_PRODUCT_WEIGHT_GM,
    length: process.env.TELAQUA_PRODUCT_LENGTH_CM,
    width: process.env.TELAQUA_PRODUCT_WIDTH_CM,
    height: process.env.TELAQUA_PRODUCT_HEIGHT_CM,
    seller: process.env.TELAQUA_BUSINESS_NAME,
  };
  process.env.TELAQUA_PRODUCT_NAME = "pH Meter";
  process.env.TELAQUA_PRODUCT_WEIGHT_GM = "300";
  process.env.TELAQUA_PRODUCT_LENGTH_CM = "15";
  process.env.TELAQUA_PRODUCT_WIDTH_CM = "10";
  process.env.TELAQUA_PRODUCT_HEIGHT_CM = "5";
  process.env.TELAQUA_BUSINESS_NAME = "Tel-Aqua";
  const defaults = getTelaquaProductDefaults();
  assert.equal(defaults.name, "pH Meter");
  assert.equal(defaults.weightGm, 300);
  assert.equal(defaults.lengthCm, 15);
  assert.equal(defaults.widthCm, 10);
  assert.equal(defaults.heightCm, 5);
  for (const [key, value] of Object.entries({
    TELAQUA_PRODUCT_NAME: saved.name,
    TELAQUA_PRODUCT_WEIGHT_GM: saved.weight,
    TELAQUA_PRODUCT_LENGTH_CM: saved.length,
    TELAQUA_PRODUCT_WIDTH_CM: saved.width,
    TELAQUA_PRODUCT_HEIGHT_CM: saved.height,
    TELAQUA_BUSINESS_NAME: saved.seller,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("Razorpay shipment payload includes package details and no cod_amount", () => {
  const item = buildShipmentPayload(prepaidOrder, shipment, warehouse, product).shipments[0];
  assert.equal(item.payment_mode, "Pre-paid");
  assert.equal(item.cod_amount, undefined);
  assert.equal(item.products_desc, "Tel-Aqua Product");
  assert.equal(item.quantity, "1");
  assert.equal(item.total_amount, 1898);
  assert.equal(item.weight, "300");
  assert.equal(item.shipment_length, 15);
  assert.equal(item.shipment_width, 10);
  assert.equal(item.shipment_height, 5);
  assert.equal(item.seller_name, "Tel-Aqua");
  assert.equal(item.seller_add, "Madhapur");
  assert.equal(item.return_pin, "500081");
});

test("COD shipment payload includes the same package details plus cod_amount", () => {
  const item = buildShipmentPayload(codOrder, shipment, warehouse, product).shipments[0];
  assert.equal(item.payment_mode, "COD");
  assert.equal(item.cod_amount, "1898");
  assert.equal(item.products_desc, "Tel-Aqua Product");
  assert.equal(item.quantity, "1");
  assert.equal(item.total_amount, 1898);
  assert.equal(item.weight, "300");
  assert.equal(item.shipment_length, 15);
  assert.equal(item.shipment_width, 10);
  assert.equal(item.shipment_height, 5);
});
