import assert from "node:assert/strict";
import test from "node:test";

import { deriveOrderDisplayStatus } from "../services/orderDisplayStatus.js";

test("unpaid orders do not receive a shipping display status", () => {
  assert.equal(deriveOrderDisplayStatus({ payment_status: "Pending" }), null);
  assert.equal(
    deriveOrderDisplayStatus({ payment_status: "Failed", waybill: "123456789" }),
    null
  );
});

test("paid orders without a shipment are ready to ship", () => {
  assert.equal(
    deriveOrderDisplayStatus({ payment_status: "Paid" }),
    "READY_TO_SHIP"
  );
});

test("paid orders with a shipment or AWB are ready to pickup", () => {
  assert.equal(
    deriveOrderDisplayStatus({ payment_status: "Paid", waybill: "123456789" }),
    "READY_TO_PICKUP"
  );
  assert.equal(
    deriveOrderDisplayStatus({
      payment_status: "Paid",
      delhivery_shipment_id: "SHIP-42",
    }),
    "READY_TO_PICKUP"
  );
});

test("stored Delhivery pickup and transit statuses display in transit", () => {
  assert.equal(
    deriveOrderDisplayStatus({
      payment_status: "Paid",
      waybill: "123456789",
      tracking_status: "Picked Up",
    }),
    "IN_TRANSIT"
  );
  assert.equal(
    deriveOrderDisplayStatus({
      payment_status: "Paid",
      waybill: "123456789",
      tracking_status: "In Transit",
    }),
    "IN_TRANSIT"
  );
});

test("stored Delhivery out-for-delivery and delivered statuses take precedence", () => {
  assert.equal(
    deriveOrderDisplayStatus({
      payment_status: "Paid",
      waybill: "123456789",
      tracking_status: "Dispatched for Delivery",
    }),
    "OUT_FOR_DELIVERY"
  );
  assert.equal(
    deriveOrderDisplayStatus({
      payment_status: "Paid",
      waybill: "123456789",
      tracking_status: "Delivered",
    }),
    "DELIVERED"
  );
});

test("fulfillment status alone cannot fabricate a tracked delivery state", () => {
  assert.equal(
    deriveOrderDisplayStatus({
      payment_status: "Paid",
      waybill: "123456789",
      fulfillment_status: "delivered",
      tracking_status: null,
    }),
    "READY_TO_PICKUP"
  );
});

test("an undelivered tracking result is never treated as delivered", () => {
  assert.equal(
    deriveOrderDisplayStatus({
      payment_status: "Paid",
      waybill: "123456789",
      tracking_status: "Undelivered",
    }),
    "READY_TO_PICKUP"
  );
});
