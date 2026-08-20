# Tel-Aqua Delhivery integration

Tel-Aqua Admin is a **logistics control panel** for Delhivery B2C — not create-shipment only. Admins can check serviceability, rates, and TAT; create warehouses; create/update shipments; generate labels; request pickup; track packages; and submit NDR actions from the dashboard.

Payment / Razorpay / promo / invoice flows are separate and unchanged.

## API surface (`/api/delhivery`, requireAuth)

| Method | Path | Purpose |
|---|---|---|
| GET | `/serviceability/:pincode` | Pincode serviceability |
| GET | `/tat` | Expected TAT (`origin_pin`, `destination_pin`, optional `mot`) |
| GET | `/waybill` | Bulk waybill fetch (`count`) |
| GET | `/rate` | Shipping rate (`md`, `cgm`, `o_pin`, `d_pin`, `ss`) |
| POST | `/warehouse/create` | Client warehouse create |
| POST | `/shipment/create` | Create shipment for an existing order (AWB) |
| POST | `/create-shipment` | Alias of shipment create |
| POST | `/shipment/update` | Edit shipment fields by waybill |
| POST | `/tracking` | Track by waybill; may persist `tracking_status` |
| POST | `/label` | Packing slip / label; may persist `label_data` |
| POST | `/pickup` | Pickup request; may persist `pickup_status` |
| POST | `/ndr` | NDR actions: `RE-ATTEMPT`, `DEFER_DLV`, `EDIT_DETAILS` |

## Create shipment flow

1. Admin clicks **Send to Delhivery** on a paid order.
2. Backend: `POST /api/delhivery/shipment/create` with `{ order_id }`.
3. Backend loads the existing `orders` row and calls Delhivery CMU create.
4. Delhivery assigns an AWB; Tel-Aqua saves on the same order row:
   - `waybill`
   - `shipment_status = 'Created'`
   - `delhivery_shipment_id`
   - `shipment_created_at`

Does not change `order_status` (Created ≠ Shipped).

## Post-create ops (in Admin)

After AWB exists, Admin can:

- **Label** — packing slip for the waybill
- **Pickup** — request collection (duplicate pickup blocked unless `force`)
- **Tracking** — refresh status onto the order when found
- **NDR** — re-attempt, defer delivery, or edit details
- **Shipment update** — edit allowed Delhivery fields by waybill

Delhivery One remains available for edge cases (wallet, warehouse naming, manual ops).

## Environment

- `DELHIVERY_API_TOKEN` — server-only
- `DELHIVERY_ENV=staging|production`
- Per-env URL vars: `DELHIVERY_STAGING_*` / `DELHIVERY_PRODUCTION_*` (pincode, TAT, waybill, rate, warehouse, shipment create/update, tracking, label, pickup, NDR)
- `TELAQUA_WAREHOUSE_NAME` — must match Delhivery pickup location name exactly
- Package weight/dimensions: `TELAQUA_PRODUCT_WEIGHT_GM`, `TELAQUA_PRODUCT_*_CM`

## Database fields (orders)

- Create flow: `waybill`, `shipment_status`, `delhivery_shipment_id`, `shipment_created_at`, `shipment_error`
- Optional logistics columns (written when present; missing columns are ignored safely):
  - `tracking_status`, `tracking_updated_at`
  - `label_data`
  - `pickup_status`, `pickup_requested_at`
