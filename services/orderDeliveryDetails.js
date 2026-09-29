/**
 * services/orderDeliveryDetails.js
 *
 * Admin correction of an order's delivery (shipping) details:
 * recipient name, mobile, address line, city, state, PIN code.
 *
 * Only the `orders` row for that order is changed — never the customer's
 * account profile or other orders. Payment, totals, order status, AWB and
 * shipment status are never touched.
 *
 * Delhivery handling depends on the shipment stage:
 *   not_created      — no manifested shipment yet: save; the corrected details
 *                      are read from `orders` when the shipment is created.
 *   awaiting_pickup  — manifested (AWB created), not yet picked up: push the
 *                      change through Delhivery's shipment edit API (/api/p/edit),
 *                      which only accepts name / add / phone. PIN, city and
 *                      state cannot be changed on an existing AWB.
 *   in_transit       — picked up or later: blocked, contact Delhivery.
 *   closed           — delivered / cancelled / returned: blocked.
 */

import { normalizeIndianPhone } from "../utils/phoneUtils.js";

export const DELIVERY_DETAIL_FIELDS = Object.freeze([
  "customer_name",
  "phone",
  "address",
  "city",
  "state",
  "pincode",
]);

export const FIELD_LABELS = Object.freeze({
  customer_name: "Recipient name",
  phone: "Mobile number",
  address: "Address",
  city: "City / locality",
  state: "State",
  pincode: "PIN code",
});

/** Order field → Delhivery /api/p/edit field. Anything else cannot be edited on an AWB. */
const COURIER_FIELD_MAP = Object.freeze({
  customer_name: "name",
  phone: "phone",
  address: "add",
});

const MAX_LENGTHS = Object.freeze({
  customer_name: 100,
  address: 500,
  city: 100,
  state: 100,
});

const AWAITING_PICKUP = new Set([
  "unfulfilled",
  "ready_to_ship",
  "shipment_created",
  "pickup_requested",
  "pickup_failed",
]);
const CLOSED = new Set(["delivered", "cancelled", "canceled", "returned"]);

const collapse = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
// Same character cleanup the shipment-create payload applies.
const courierClean = (value) =>
  String(value ?? "").replace(/[&#%;\\]/g, " ").replace(/\s+/g, " ").trim();

/**
 * @returns {{ data: Record<string,string> } | { errors: Record<string,string> }}
 */
export function validateDeliveryDetails(body) {
  const errors = {};
  if (!body || typeof body !== "object") {
    return { errors: { _form: "Invalid request body." } };
  }

  const data = {
    customer_name: collapse(body.customer_name),
    phone: String(body.phone ?? "").trim(),
    address: collapse(body.address),
    city: collapse(body.city),
    state: collapse(body.state),
    pincode: String(body.pincode ?? "").replace(/\s+/g, ""),
  };

  for (const field of DELIVERY_DETAIL_FIELDS) {
    if (!data[field]) errors[field] = `${FIELD_LABELS[field]} is required.`;
  }
  for (const [field, max] of Object.entries(MAX_LENGTHS)) {
    if (data[field] && data[field].length > max) {
      errors[field] = `${FIELD_LABELS[field]} must be at most ${max} characters.`;
    }
  }
  if (data.customer_name && data.customer_name.length < 2 && !errors.customer_name) {
    errors.customer_name = "Recipient name must be at least 2 characters.";
  }
  if (data.address && data.address.length < 5 && !errors.address) {
    errors.address = "Address looks incomplete — include house/street and area.";
  }

  if (data.phone) {
    // Accept +91 / 0 prefixes and spaces, store the bare 10 digits.
    const phone = normalizeIndianPhone(data.phone);
    if (phone.error || !/^[\d\s+()-]+$/.test(data.phone)) {
      errors.phone = "Enter a valid 10-digit Indian mobile number (starting with 6–9).";
    } else {
      data.phone = phone.phoneNumber;
    }
  }

  if (data.pincode && !/^[1-9]\d{5}$/.test(data.pincode)) {
    errors.pincode = "PIN code must be exactly 6 digits (and cannot start with 0).";
  }

  return Object.keys(errors).length ? { errors } : { data };
}

export function pickDeliveryDetails(order) {
  return Object.fromEntries(
    DELIVERY_DETAIL_FIELDS.map((field) => [field, order?.[field] == null ? "" : String(order[field])])
  );
}

/** Fields whose value actually changes (whitespace-insensitive). */
export function diffDeliveryDetails(order, next) {
  const before = pickDeliveryDetails(order);
  return DELIVERY_DETAIL_FIELDS
    .filter((field) => collapse(before[field]) !== collapse(next[field]))
    .map((field) => ({ field, before: before[field], after: next[field] }));
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

/**
 * Decide what may happen with a delivery-details change given the order and
 * its (sequence 1) shipment row. The shipments row is authoritative; legacy
 * order columns are the fallback for pre-migration orders.
 */
export function classifyShipmentStage(order, shipment) {
  const orderStatus = String(order?.order_status || "").trim().toLowerCase();
  const fulfillment = String(
    shipment?.fulfillment_status || order?.fulfillment_status || "unfulfilled"
  ).trim().toLowerCase();
  const waybill = shipment?.waybill_number || order?.waybill || null;
  const manifested = Boolean(
    shipment
      ? hasValue(shipment.shipment_created_at) || hasValue(shipment.shipment_id)
      : hasValue(order?.shipment_created_at) || hasValue(order?.delhivery_shipment_id)
  );

  if (orderStatus === "cancelled" || orderStatus === "delivered" || CLOSED.has(fulfillment)) {
    return { stage: "closed", fulfillment, waybill, manifested };
  }
  if (!manifested) return { stage: "not_created", fulfillment, waybill, manifested };
  if (AWAITING_PICKUP.has(fulfillment)) {
    return { stage: "awaiting_pickup", fulfillment, waybill, manifested };
  }
  return { stage: "in_transit", fulfillment, waybill, manifested };
}

const FULFILLMENT_LABELS = {
  picked_up: "Picked Up",
  in_transit: "In Transit",
  out_for_delivery: "Out for Delivery",
  ndr: "Delivery Exception (NDR)",
  rto: "RTO",
  delivery_failed: "Delivery Failed",
  delivered: "Delivered",
  cancelled: "Cancelled",
  returned: "Returned",
};

export function lockedStageMessage(classification) {
  const label = FULFILLMENT_LABELS[classification.fulfillment] || classification.fulfillment;
  const awb = classification.waybill ? ` (AWB ${classification.waybill})` : "";
  if (classification.stage === "closed") {
    return `Delivery details cannot be changed because this order is ${label || "closed"}${awb}.`;
  }
  const ndrHint = classification.fulfillment === "ndr"
    ? " While the shipment is in NDR you can also use Open NDR Actions → EDIT_DETAILS."
    : "";
  return (
    `The shipment is already ${label}${awb}, so Tel-Aqua cannot change the delivery details ` +
    `with Delhivery. The order was not changed. Contact Delhivery support with the AWB to ` +
    `correct the address or phone, then update the order once they confirm.${ndrHint}`
  );
}

/** Build the /api/p/edit body from the corrected details (only courier-editable fields). */
export function buildCourierUpdatePayload(waybill, data) {
  const payload = { waybill: String(waybill) };
  for (const [field, courierField] of Object.entries(COURIER_FIELD_MAP)) {
    const value = courierClean(data[field]);
    if (value) payload[courierField] = value;
  }
  return payload;
}

export function courierUnsupportedChanges(changes) {
  return changes.filter((change) => !COURIER_FIELD_MAP[change.field]);
}

function describeFields(changes) {
  return changes.map((change) => FIELD_LABELS[change.field]).join(", ");
}

/**
 * Save flow. All I/O is injected so the decision logic is testable.
 *
 * deps: {
 *   loadOrder(orderId) → order | null
 *   loadShipment(orderId) → shipment | null
 *   refreshTracking(shipment) → void            (best effort, optional)
 *   latestAudit(orderId) → audit row | null
 *   lockShipment(shipment) → token              (throws { httpStatus, publicMessage })
 *   pushToCourier(payload) → Delhivery response (throws on failure)
 *   releaseShipment({ shipment, token, courier, payload })
 *   persist({ order, shipment, data, changes, classification, courier, admin, action })
 * }
 *
 * @returns {{ status: number, body: object }}
 */
export async function saveOrderDeliveryDetails({ orderId, body, admin }, deps) {
  const validation = validateDeliveryDetails(body);
  if (validation.errors) {
    return {
      status: 400,
      body: {
        success: false,
        code: "VALIDATION_FAILED",
        message: "Please correct the highlighted delivery details.",
        errors: validation.errors,
      },
    };
  }
  const data = validation.data;

  const order = await deps.loadOrder(orderId);
  if (!order) return { status: 404, body: { success: false, message: "Order not found." } };

  let shipment = await deps.loadShipment(orderId);
  let classification = classifyShipmentStage(order, shipment);
  let trackingChecked = false;

  // Stored status can lag Delhivery by a few minutes; re-check before editing
  // a manifested shipment so a just-picked-up package is not edited as "ready".
  if (classification.stage === "awaiting_pickup" && shipment && deps.refreshTracking) {
    try {
      await deps.refreshTracking(shipment);
      trackingChecked = true;
      shipment = (await deps.loadShipment(orderId)) || shipment;
      classification = classifyShipmentStage(order, shipment);
    } catch (error) {
      console.warn("Delivery details: live tracking check failed; using stored status", {
        orderId,
        code: error?.code,
      });
    }
  }

  const stageInfo = {
    stage: classification.stage,
    fulfillment_status: classification.fulfillment,
    waybill: classification.waybill,
    tracking_checked: trackingChecked,
  };

  if (classification.stage === "closed" || classification.stage === "in_transit") {
    return {
      status: 409,
      body: {
        success: false,
        code: "COURIER_LOCKED",
        message: lockedStageMessage(classification),
        shipment: stageInfo,
      },
    };
  }

  const changes = diffDeliveryDetails(order, data);
  const lastAudit = deps.latestAudit ? await deps.latestAudit(orderId) : null;
  const courierRetry =
    changes.length === 0 &&
    classification.stage === "awaiting_pickup" &&
    lastAudit?.courier_status === "failed";

  if (changes.length === 0 && !courierRetry) {
    return {
      status: 400,
      body: {
        success: false,
        code: "NO_CHANGES",
        message: "No delivery details were changed.",
      },
    };
  }

  if (classification.stage === "awaiting_pickup") {
    const unsupported = courierUnsupportedChanges(changes);
    if (unsupported.length) {
      return {
        status: 409,
        body: {
          success: false,
          code: "COURIER_FIELD_UNSUPPORTED",
          message:
            `${describeFields(unsupported)} cannot be changed after the Delhivery AWB ` +
            `${classification.waybill || ""} is created — Delhivery's shipment edit API only ` +
            `accepts recipient name, address line and mobile number. The order was not changed. ` +
            `To deliver to a different PIN/city/state, contact Delhivery support (or cancel the AWB ` +
            `in the Delhivery portal and create a new shipment).`,
          fields: unsupported.map((change) => change.field),
          shipment: stageInfo,
        },
      };
    }
  }

  let courier = {
    status: "not_required",
    message: "No Delhivery shipment exists yet; the corrected details will be used when the shipment is created.",
  };

  if (classification.stage === "awaiting_pickup") {
    if (!classification.waybill) {
      courier = { status: "failed", message: "Shipment has no AWB on record, so Delhivery could not be updated." };
    } else {
      const payload = buildCourierUpdatePayload(classification.waybill, data);
      let token = null;
      try {
        token = await deps.lockShipment(shipment);
      } catch (error) {
        return {
          status: error?.httpStatus || 409,
          body: {
            success: false,
            code: "SHIPMENT_BUSY",
            message: error?.publicMessage || "Another shipment operation is in progress. Try again shortly.",
          },
        };
      }
      try {
        const response = await deps.pushToCourier(payload);
        courier = {
          status: "updated",
          message: `Delhivery accepted the update for AWB ${classification.waybill}.`,
          remark: String(response?.remark || response?.message || "").slice(0, 500) || null,
          response,
          payload,
        };
      } catch (error) {
        courier = {
          status: "failed",
          message: String(error?.message || "Delhivery did not accept the update.").slice(0, 900),
          response: error?.upstreamBody || null,
          payload,
        };
      } finally {
        await deps.releaseShipment({ shipment, token, courier, payload });
      }
    }
  }

  await deps.persist({
    order,
    shipment,
    data,
    changes,
    classification,
    courier,
    admin,
    action: courierRetry ? "courier_sync_retry" : "delivery_details_updated",
  });

  const updatedOrder = await deps.loadOrder(orderId);
  const awb = classification.waybill;
  const message =
    courier.status === "updated"
      ? `Delivery details updated. Delhivery accepted the change for AWB ${awb}.`
      : courier.status === "failed"
        ? `Delivery details were saved in Tel-Aqua, but Delhivery was NOT updated${awb ? ` for AWB ${awb}` : ""}: ` +
          `${courier.message} The courier still has the old details — retry from this screen or contact Delhivery.`
        : "Delivery details updated. They will be used when the Delhivery shipment is created.";

  return {
    status: 200,
    body: {
      success: true,
      message,
      changes: changes.map((change) => change.field),
      courier_sync: {
        status: courier.status,
        message: courier.message,
        remark: courier.remark || null,
      },
      shipment: stageInfo,
      order: updatedOrder,
    },
  };
}
