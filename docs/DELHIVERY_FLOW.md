# Tel-Aqua Delhivery integration

Tel-Aqua admin implements **Create Shipment only**. Pickup, labels, and delivery states are handled in **Delhivery One** — not in Tel-Aqua.

## What Tel-Aqua does

1. Admin clicks **Send to Delhivery** on a paid order.
2. Backend: `POST /api/delhivery/shipment/create` with `{ order_id }`.
3. Backend loads the existing `orders` row and calls Delhivery CMU:
   - `POST https://track.delhivery.com/api/cmu/create.json` (production)
   - Body: `format=json&data=<JSON>` (pickup location + shipment details).
4. Delhivery manifests the package and **assigns an AWB**.
5. Tel-Aqua saves on the same order row:
   - `waybill` (when returned)
   - `shipment_status = 'Created'`
   - `delhivery_shipment_id` (when returned)
   - `shipment_created_at`

Tel-Aqua does **not** call:

- Pickup Request API (`/fm/request/new/`)
- Label / packing slip API
- Tracking API (customer tracking uses stored AWB only)

## What Delhivery One does (operator workflow)

After Create Shipment succeeds, open [Delhivery One](https://one.delhivery.com):

| Delhivery One state | Meaning |
|---|---|
| **Ready to Ship** | Normal result after Tel-Aqua Create Shipment (AWB generated) |
| **Ready for Pickup** | After **Add to Pickup** is completed in Delhivery One |
| **In Transit** | After Delhivery collects the package |
| **Delivered** | Final delivery |

**Ready to Ship after Create Shipment is correct.** Tel-Aqua does not move shipments to Ready for Pickup.

## Manual pickup in Delhivery One

1. **Forward Orders → Ready to Ship** — confirm the AWB.
2. Select shipment(s) → **Add Pickup**.
3. Choose pickup location (must match `TELAQUA_WAREHOUSE_NAME` exactly).
4. Set pickup date and slot → confirm.
5. Shipment moves to **Ready for Pickup** when Delhivery accepts the pickup request.

If Add to Pickup does not move the state, check Delhivery One for errors, wallet limits, or warehouse name mismatch. That is a **Delhivery-side** workflow issue, not a Tel-Aqua bug.

## Environment

- `DELHIVERY_API_TOKEN` — server-only
- `DELHIVERY_ENV=production` on Hostinger
- `TELAQUA_WAREHOUSE_NAME` — must match Delhivery One pickup location name exactly

## Database fields (existing)

- `waybill`, `shipment_status`, `delhivery_shipment_id`, `shipment_created_at`, `shipment_error`
- `pickup_status`, `pickup_requested_at` — optional columns; **not written** by Tel-Aqua create flow
