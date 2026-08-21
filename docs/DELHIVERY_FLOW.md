# Tel-Aqua Delhivery fulfillment

Delhivery is an independent logistics layer. It never creates, verifies, refunds,
or changes a Razorpay payment. Shipment creation requires the existing order's
`payment_status` to already be `Paid`.

## Deployment

1. Back up the MySQL database.
2. Set `DELHIVERY_ENV=staging` and all `DELHIVERY_STAGING_*` URLs, the server-only
   `DELHIVERY_API_TOKEN`, `TELAQUA_WAREHOUSE_*`, `TELAQUA_PRODUCT_NAME`, and
   `TELAQUA_PRODUCT_WEIGHT_GM`.
3. Run `npm run migrate:delhivery`. The migration is additive and backfills legacy
   order shipment fields into sequence 1 without altering payment fields.
4. Deploy the API and Admin build. Keep production URLs configured but production
   is selected only by explicitly setting `DELHIVERY_ENV=production`.
5. Optionally enable the backend worker with
   `DELHIVERY_TRACKING_SYNC_ENABLED=true`; its minimum interval is 15 minutes.

## Admin API (Bearer admin JWT required)

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/admin/logistics/serviceability/:pincode` | Serviceability |
| POST | `/api/admin/logistics/tat` | Expected delivery/TAT |
| POST | `/api/admin/logistics/rate` | Administrative shipping estimate |
| POST | `/api/admin/logistics/waybill` | Reserve one AWB for an order |
| GET/POST | `/api/admin/logistics/warehouse` | Show/create configured warehouse |
| GET | `/api/admin/logistics/orders/:orderId` | Order fulfillment aggregate |
| POST | `/api/admin/logistics/orders/:orderId/shipment` | Idempotent paid-order shipment creation |
| GET/PUT | `/api/admin/logistics/shipments/:shipmentId` | Shipment detail/supported edits |
| GET | `/api/admin/logistics/shipments/:shipmentId/label` | Generate/view label |
| POST | `/api/admin/logistics/shipments/:shipmentId/pickup` | Request pickup once |
| POST | `/api/admin/logistics/shipments/:shipmentId/track` | Refresh one shipment |
| POST | `/api/admin/logistics/shipments/track-active` | Refresh a bounded active batch |
| GET | `/api/admin/logistics/shipments/:shipmentId/tracking` | Stored timeline |
| GET/POST | `/api/admin/logistics/shipments/:shipmentId/ndr` | NDR detail/supported action |

Legacy `/api/delhivery/*` endpoints remain mounted for compatibility.

## Flow and invariants

`Paid Order -> Serviceability -> TAT/Rate -> Waybill -> Shipment -> Label -> Pickup -> Tracking -> Delivery`

- Payment and fulfillment statuses stay separate.
- `(order_id, sequence_no)`, `idempotency_key`, and `waybill_number` are unique.
- A transaction locks the order/current shipment before an external create call.
- An in-progress token blocks double-clicks and concurrent admins; it expires for
  recovery after ten minutes.
- Failed Delhivery operations save a diagnostic error but never change payment.
- Tracking events append to history. Terminal statuses cannot regress.
- Delivered/cancelled/returned shipments are excluded from background refresh.
- Shipment edits are allowlisted and blocked in terminal states.
- NDR actions are limited to Delhivery-supported `RE-ATTEMPT`, `DEFER_DLV`, and
  `EDIT_DETAILS`, and only appear while the stored fulfillment state is NDR.

## Data model

- `orders.fulfillment_status`: separate from `payment_status`.
- `shipments`: one current sequence with room for later multi-shipment orders;
  operational fields, raw responses, idempotency lock, and indexed status/AWB.
- `shipment_tracking_history`: append-only normalized scans.
- `shipment_audit_log`: important admin operations.
- `logistics_warehouses`: Delhivery warehouse references; supports multiple rows.

## Staging test checklist

Do not mark an integration WORKING until a real staging response is received.
Test serviceability, TAT, rate, warehouse, waybill, shipment create, label, pickup,
tracking, update, and NDR in that order. Then rerun the normal Razorpay test-mode
checkout, verification, webhook, payment-ID persistence, and mobile recovery flow.
