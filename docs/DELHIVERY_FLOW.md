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
6. Configure a private header name/value in `DELHIVERY_WEBHOOK_AUTH_HEADER` and
   `DELHIVERY_WEBHOOK_AUTH_VALUE`. Give that same header to Delhivery during Scan
   Push onboarding. Optionally set `DELHIVERY_WEBHOOK_ALLOWED_IPS` to the current
   source IP list supplied by Delhivery.

The Settings page reports server-side readiness and lists missing variable names;
it never returns tokens or secret values to the browser.

## Delhivery Scan Push webhook

The public receiver is `POST /api/delhivery/webhook`. It accepts Delhivery's
official `Shipment.Status` Scan Push JSON, authenticates the client-defined
header, matches an existing shipment by AWB, stores the raw scan, and returns
HTTP 200 after a valid event is persisted. The route intentionally does not use
an admin JWT because Delhivery calls it server-to-server.

Each event has a deterministic SHA-256 key. Duplicate deliveries are ignored,
older scans remain in history without replacing the current status, and terminal
states cannot regress. Unknown AWBs and malformed or unauthenticated requests do
not alter orders or shipments. The existing Tracking API remains the fallback;
it applies the same timestamp guard before updating MySQL.

For the current production API host, register:

`https://lightpink-reindeer-561421.hostingersite.com/api/delhivery/webhook`

Delhivery's official Scan Push onboarding requires the completed requirement
document (development and production URL plus the agreed header) to be emailed
to `lastmile-integration@delhivery.com`, copying the business POC. Delhivery's
technical team tests the receiver before releasing the production push. Do not
consider automatic synchronization live until the migration, environment values,
API deployment, and Delhivery activation are all complete.

## Required Delhivery account setup

These are real prerequisites, not application fallbacks:

1. In **Delhivery One → Settings → API Setup**, obtain a staging/test token and,
   only after staging acceptance, request a live token. Store it only as the
   backend `DELHIVERY_API_TOKEN`. Generating a replacement invalidates the old
   token. This is normally one-time, except when rotating a token.
2. In **Delhivery One → Developer Portal**, copy the account-specific staging
   and production URLs and validate the request/response examples for all eleven
   operations. Put those URLs in the matching Hostinger environment variables.
   This is one-time unless Delhivery changes an endpoint or account entitlement.
3. Register/approve the exact pickup-location name in **Delhivery One warehouse /
   pickup-location settings**. `TELAQUA_WAREHOUSE_NAME` must match that registered
   name exactly. This is one-time per warehouse; pickup requests depend on it.
4. Ask Delhivery support/account management to enable any API that the Developer
   Portal does not expose for the account (rate, update, label, pickup, or NDR are
   commonly entitlement/state dependent). This is one-time per account feature.
5. Keep sufficient account/wallet/service activation for shipment operations.
   Funding and operational exceptions are recurring account responsibilities;
   the application does not simulate acceptance when Delhivery rejects a call.

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
| POST | `/api/admin/logistics/shipments/:shipmentId/pickup` | Request pickup once |
| POST | `/api/admin/logistics/shipments/:shipmentId/track` | Refresh one shipment |
| POST | `/api/admin/logistics/shipments/track-active` | Refresh a bounded active batch |
| GET | `/api/admin/logistics/shipments/:shipmentId/tracking` | Stored timeline |
| GET/POST | `/api/admin/logistics/shipments/:shipmentId/ndr` | NDR detail/supported action |

Legacy `/api/delhivery/*` endpoints remain mounted for compatibility, but now
delegate to the same persisted/idempotent controllers. The legacy waybill route
requires `order_id`; it no longer allocates anonymous/unassigned AWBs.

## Flow and invariants

`Paid Order -> Serviceability -> TAT/Rate -> Waybill -> Shipment -> Label -> Pickup -> Tracking -> Delivery`

- Payment and fulfillment statuses stay separate.
- `(order_id, sequence_no)`, `idempotency_key`, and `waybill_number` are unique.
- A transaction locks the order/current shipment before an external create call.
- An in-progress token blocks double-clicks and concurrent admins; it expires for
  recovery after ten minutes.
- Failed Delhivery operations save a diagnostic error but never change payment.
- HTTP 200 bodies are also validated; a logical failure or missing required AWB,
  charge, label reference, pickup confirmation, or tracking state is an error.
- Serviceability, TAT, rate, label, pickup, and current tracking details persist
  with timestamps and survive an Admin page refresh.
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

Do not run shipment/waybill/pickup tests against a real paid order without an
approved staging token, registered staging pickup location, and a disposable test
order. The application deliberately returns a configuration error instead of a
fake success when those prerequisites are absent.
