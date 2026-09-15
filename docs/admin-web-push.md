# Admin Web Push (new-order notifications)

Multi-device Web Push for the Tel-Aqua admin dashboard. Inventory `NotificationBell` is unchanged.

## What it does

- Detects **committed** rows in `orders` via a background worker (does not hook order-placement transactions).
- Sends system notifications to every registered admin device (Windows Chrome/Edge, Android Chrome).
- Works when the admin tab is closed (subject to OS/browser push limits).

## Baseline, late commits, restarts

1. On first worker start after migration, `order_push_worker_state` stores `baseline_order_id = MAX(orders.id)`. Orders at or below that id never notify.
2. Each scan selects orders with `id > baseline` that are not yet in `order_push_notifications`, using `id > high_watermark_id` **or** `created_at` within `ORDER_PUSH_LOOKBACK_SECONDS` of the watermark (default 120s) so late-committing transactions are not missed.
3. `UNIQUE(order_id)` on notifications and `UNIQUE(notification_id, subscription_id)` on deliveries prevent duplicate jobs across overlapping scans or multiple Node instances.
4. Watermark is durable in MySQL; process restarts continue from the stored watermark + lookback.

## Migration (prepare only until you choose to apply)

```bash
cd telaqua_mysql_backend
# Inspect SQL: sql/add_admin_web_push.sql
node scripts/migrate-admin-web-push.js
```

Or run `npm run migrate:admin-web-push`. Do **not** apply to production until you intentionally deploy this feature.

## VAPID configuration (Hostinger / `.env`)

Reuse existing keys if you already generated them. Generate once if needed:

```bash
npx web-push generate-vapid-keys
```

Set on the **backend only**:

```
WEB_PUSH_VAPID_PUBLIC_KEY=...
WEB_PUSH_VAPID_PRIVATE_KEY=...
WEB_PUSH_VAPID_SUBJECT=mailto:admin@telaqua.com
ORDER_PUSH_ENABLED=true
ORDER_PUSH_SCAN_INTERVAL_MS=20000
ORDER_PUSH_LOOKBACK_SECONDS=120
```

Never put the private key in the admin SPA or commit it.

## Hostinger worker / deployment

This project starts the order-push worker inside the same Node process as the API (`server.js`), alongside logistics sync and checkout reminders:

1. Deploy backend code that includes `web-push`, routes `/api/admin/push/*`, and `startOrderPushWorker()`.
2. Apply the migration against Hostinger MySQL.
3. Set the VAPID env vars in Hostinger’s Node environment.
4. Restart the Node app so `server.js` boots the worker.
5. Deploy the admin frontend that includes `public/sw.js` and Settings → Order notifications.

There is **no separate Hostinger cron/worker binary** for this feature. If Hostinger suspends the Node process when idle, scanning pauses until the app wakes (same limitation as other in-process timers).

## Enable / test / disable per device

1. Sign in to the admin dashboard on that device.
2. Open **Settings → Order notifications**.
3. Click **Enable order notifications** (browser permission is requested only then).
4. Status shows **Enabled** only after the backend accepts the subscription.
5. **Send test notification** targets **this device only** and creates **no order**.
6. **Disable on this device** removes only this browser’s subscription; other devices stay registered.
7. Repeat on Windows Chrome/Edge and Android Chrome for multi-device.

On logout, the app attempts authenticated server revoke **before** clearing the JWT, then unsubscribes the browser. If the device is offline, local logout still succeeds; server revocation may lag until the endpoint expires (410) or you disable again while online. A failed revoke is shown on the login screen — it does not claim success.

## Detection interval and delay

Default scan interval: **20 seconds** (`ORDER_PUSH_SCAN_INTERVAL_MS`). Expected notification delay after an order commits: roughly **0–20s**, plus push-network latency (often under a few seconds). Lookback default **120s** for late commits.

## Manual device checks (not claimed passed unless you run them)

**Windows Chrome/Edge**

1. Enable notifications in Settings; close the admin tab (leave browser running).
2. Place a real/test order that creates a committed `orders` row.
3. Confirm a system notification: title “New order received”, body with order number, amount, payment mode/status (pending Razorpay must not say Paid).
4. Click notification → admin opens/focuses `/orders/:id` after login if needed.
5. Send test; disable on PC; confirm phone still receives.

**Android Chrome**

1. Enable on phone; close tab / leave Chrome in background.
2. Confirm notification for a new order and for test-only-on-this-device.
3. Disable on phone; confirm Windows still receives.

## Limits

- Requires HTTPS admin origin (or localhost).
- Browser/OS may delay or suppress notifications when battery optimization is aggressive.
- Inactive admins (`is_active` false) are excluded from delivery.
- Inventory alert bell/API is separate and unchanged.
