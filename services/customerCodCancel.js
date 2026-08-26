/**
 * Customer self-cancel rules for COD orders.
 * Razorpay/online orders are never eligible. Does not call Delhivery.
 */

import { isCodOrder } from "./paymentMode.js";

const EMPTY_SHIPMENT_STATUSES = new Set(["", "not created", "pending", "none"]);
const OPEN_FULFILLMENT = new Set(["", "unfulfilled", "cancelled"]);

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

export function hasBlockingShipment(order = {}, shipment = null) {
  const shipmentSignals = [
    order.waybill,
    order.tracking_number,
    order.awb,
    order.delhivery_shipment_id,
    order.shipment_created_at,
    order.shipment_confirmed_at,
    order.pickup_requested_at,
    shipment?.waybill_number,
    shipment?.waybill,
    shipment?.shipment_id,
    shipment?.shipment_created_at,
    shipment?.pickup_requested_at,
  ];
  if (shipmentSignals.some(hasValue)) return true;

  const fulfillment = normalizeStatus(
    shipment?.fulfillment_status || order.fulfillment_status
  );
  if (fulfillment && !OPEN_FULFILLMENT.has(fulfillment)) return true;

  const shipmentStatus = normalizeStatus(
    order.shipment_status || shipment?.shipment_status
  );
  if (shipmentStatus && !EMPTY_SHIPMENT_STATUSES.has(shipmentStatus)) return true;

  return false;
}

export function evaluateCustomerCodCancel(order, shipment = null) {
  if (!order) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "Order not found",
    };
  }

  if (!isCodOrder(order)) {
    return {
      ok: false,
      status: 400,
      code: "NOT_COD",
      message: "Only Cash on Delivery orders can be cancelled.",
    };
  }

  const statusKey = normalizeStatus(order.order_status || order.status);
  if (statusKey === "cancelled") {
    return {
      ok: false,
      status: 409,
      code: "ALREADY_CANCELLED",
      message: "This order has already been cancelled.",
    };
  }

  if (statusKey === "delivered" || statusKey === "completed") {
    return {
      ok: false,
      status: 409,
      code: "NOT_ELIGIBLE",
      message: "This order cannot be cancelled.",
    };
  }

  if (statusKey === "shipped" || hasBlockingShipment(order, shipment)) {
    return {
      ok: false,
      status: 409,
      code: "SHIPPED",
      message: "This order cannot be cancelled because it has already been shipped.",
    };
  }

  return { ok: true };
}

export function isCustomerCodCancellable(order, shipment = null) {
  return evaluateCustomerCodCancel(order, shipment).ok === true;
}
