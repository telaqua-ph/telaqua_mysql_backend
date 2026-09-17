import assert from "node:assert/strict";
import test from "node:test";

import { deriveOrderConfirmationStatus } from "../services/orderDisplayStatus.js";
import { deriveShipmentStatusDisplay } from "../services/shipmentStatusDisplay.js";

test("new orders remain new regardless of payment or shipment fields", () => {
  assert.equal(deriveOrderConfirmationStatus({ order_status: "New", payment_status: "Pending" }), "New");
  assert.equal(deriveOrderConfirmationStatus({ order_status: "New", payment_status: "Failed", waybill: "123456789" }), "New");
});

test("the existing payment confirmation flow is confirmed", () => {
  assert.equal(deriveOrderConfirmationStatus({ order_status: "Confirmed", payment_status: "Paid" }), "Confirmed");
  assert.equal(deriveOrderConfirmationStatus({ order_status: "Unknown legacy value", payment_status: "Paid" }), "Confirmed");
});

test("known fulfillment-like legacy order statuses map to confirmed", () => {
  for (const order_status of ["Ready to Ship", "Ready to Pickup", "Shipped", "In Transit", "Out for Delivery", "Delivered"]) {
    assert.equal(deriveOrderConfirmationStatus({ order_status, payment_status: "Pending" }), "Confirmed", order_status);
  }
});

test("shipment progress never changes the confirmation label", () => {
  assert.equal(deriveOrderConfirmationStatus({ order_status: "Confirmed", tracking_status: "Delivered" }), "Confirmed");
  assert.equal(deriveOrderConfirmationStatus({ order_status: "New", tracking_status: "Delivered" }), "New");
});

test("unknown exceptional statuses are not blindly mapped to confirmed", () => {
  assert.equal(deriveOrderConfirmationStatus({ order_status: "Cancelled", payment_status: "Failed" }), "New");
  assert.equal(deriveOrderConfirmationStatus({ order_status: "Returned", payment_status: "Pending" }), "New");
});

test("the reported Orders-page examples keep confirmation and shipment separate", () => {
  assert.equal(deriveOrderConfirmationStatus({ order_status: "Confirmed", payment_status: "Pending" }), "Confirmed", "TAQ-000663");
  assert.equal(deriveShipmentStatusDisplay({ payment_status: "Pending", fulfillment_status: "shipment_created" }), "Ready to Pickup", "TAQ-000663 shipment");
  assert.equal(deriveOrderConfirmationStatus({ order_status: "Ready to Ship", payment_status: "Paid" }), "Confirmed", "TAQ-000662");
  assert.equal(deriveOrderConfirmationStatus({ order_status: "New", payment_status: "Failed", fulfillment_status: "shipment_created" }), "New", "TAQ-000661");
  assert.equal(deriveOrderConfirmationStatus({ order_status: "Confirmed", payment_status: "Paid", tracking_status: "Delivered" }), "Confirmed", "delivered confirmation");
  assert.equal(deriveShipmentStatusDisplay({ payment_status: "Paid", tracking_status: "Delivered" }), "Delivered", "delivered shipment");
});
