# Razorpay to Swipe invoice integration

## What this project contains

This repository is the Express/Node.js backend. It uses PostgreSQL through `pg`.
The customer website is not in this repository, so its My Orders and payment-success
screens must call the backend endpoints described below.

The checkout sells one Tel-Aqua product. Product and promo prices are GST-inclusive.
Promo codes are read from `promo_codes`; the browser cannot set the price.

## One-time database setup

Run `sql/add_invoice_fields.sql` against the production PostgreSQL database before
deploying this code. It adds financial snapshots, Swipe identifiers, an invoice
creation lock, a guest access-token hash, and Razorpay webhook event deduplication.

## Environment variables

Set these only on the backend host:

```env
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
SWIPE_API_KEY=
SWIPE_BASE_URL=https://app.getswipe.in/api/partner/v2
```

Never put the three secrets in frontend JavaScript. `RAZORPAY_KEY_ID` is the only
Razorpay value returned to checkout.

## Checkout and coupon calculation

`POST /api/payment/create-order` validates the customer and quantity. It looks up
the promo code in PostgreSQL and ignores browser-supplied prices. It stores:

- original subtotal and discount;
- discounted taxable value;
- GST (currently the existing 18% GST-inclusive pricing rule);
- shipping (currently the existing value of zero);
- final total.

The website order is created first. The backend then creates a Razorpay order in
paise and stores its ID. Razorpay notes contain the website order number.

Keep `db_order_id`, `order_number`, and `invoice_access_token` from the response in
the checkout session. The access token is random; only its SHA-256 hash is stored.

## Payment verification

Send the three fields returned by Razorpay Checkout to:

```http
POST /api/payment/verify-payment
Content-Type: application/json

{
  "razorpay_order_id": "order_...",
  "razorpay_payment_id": "pay_...",
  "razorpay_signature": "..."
}
```

The backend checks the HMAC signature using its stored Razorpay order ID. It also
fetches the order and payment from Razorpay and checks that the payment is captured,
belongs to that order, uses INR, and exactly matches the stored final total. Only
then does it mark the website order Paid.

## Razorpay webhook

Webhook URL:

```text
https://YOUR-DOMAIN/api/webhooks/razorpay
```

Enable these events:

- `payment.captured`
- `order.paid`
- `payment.failed`

The route verifies `X-Razorpay-Signature` against the untouched raw body. Event IDs
are stored so a retry is safe. Captured payloads must also match the order amount
and currency. Both the checkout callback and webhook call the same invoice service.

In Razorpay Dashboard, create a webhook secret and copy the exact same value into
`RAZORPAY_WEBHOOK_SECRET` on the backend. Enable automatic payment capture; an
authorized but uncaptured payment is not treated as paid.

## Swipe invoice creation

`ensureSwipeInvoiceForPaidOrder(orderId)` is the only function that creates a Swipe
invoice. An atomic PostgreSQL update claims the order before the external API call.
Concurrent callbacks see the pending claim and do not call Swipe. Failed claims can
be retried; claims older than five minutes can be recovered.

The payload uses the order's customer and financial snapshots. It does not read a
current product price or apply Swipe's invoice-level discount. The payment amount
sent to Swipe equals the captured Razorpay amount. Shipping is a separate line when
non-zero. The reference contains both the website order and Razorpay payment IDs.

On success, Swipe's `hash_id` and `serial_number` are stored. A Swipe failure leaves
the order Paid and changes only `invoice_status` to `failed`.

## Invoice status and download

For guest checkout, poll:

```http
POST /api/payment/invoice-status
Content-Type: application/json

{
  "order_id": 1058,
  "invoice_access_token": "the token returned at checkout"
}
```

Download with either the `X-Order-Token` header or this browser-friendly URL:

```text
/api/payment/invoice-download?order_id=1058&invoice_access_token=TOKEN
```

The backend checks the token, Paid status, and Swipe hash, then downloads the PDF
server-to-server. If Swipe PDF retrieval is unavailable (including an exhausted API
allowance), the backend returns a PDF generated from the immutable paid-order
snapshot. The Swipe key never reaches the browser. Avoid logging or sharing URLs
containing the guest token.

Admin users can retry and download with their normal Bearer JWT:

```text
POST /api/orders/:orderId/invoice
GET  /api/orders/:orderId/invoice/download
```

## Frontend wiring

The frontend is a separate project and must do the following:

1. Save `db_order_id`, `order_number`, and `invoice_access_token` after create-order.
2. Send Razorpay's callback fields to `verify-payment`; never mark Paid locally.
3. Show payment success after backend verification.
4. Poll `invoice-status` briefly. Do not block the success page indefinitely.
5. Show “Invoice is being generated” while it is not ready.
6. Show “Download Invoice” when `invoice_ready` is true.
7. Store the guest token securely for guest order retrieval. Logged-in My Orders can
   use a future customer-auth route; the existing Bearer routes are admin routes.

## Swipe dashboard setup

1. In Swipe, create a partner API key and set it as `SWIPE_API_KEY` on the backend.
2. Check the business name, GSTIN, registered state, and address.
3. Check the invoice number series and invoice PDF template.
4. Check bank/payment details if they should appear on the invoice.
5. Enable Swipe's automatic invoice email delivery if the plan supports it.
6. Enable automatic WhatsApp delivery and add wallet credits if Swipe requires them.
7. The code supplies customer name, email, phone, country code, and order address.
   WhatsApp sending also respects the website's recorded consent.

Dashboard automation is intentionally not changed through code.

## Test checklist

Use Razorpay Test Mode first. Run `npm test`, then manually test:

- no coupon, a percentage-equivalent promo, and a fixed-price promo;
- quantities greater than one;
- final website rupees × 100 equals the Razorpay paise amount;
- Swipe item totals plus shipping equal the same final total;
- captured payment creates one invoice;
- failed/uncaptured payment creates no invoice;
- duplicate callback and duplicate webhook still create one invoice;
- Swipe outage leaves payment Paid and allows admin retry;
- the correct email and phone appear in Swipe;
- correct guest token downloads; wrong token returns 403;
- changing a promo/product later does not change the saved order invoice.

For a low-value live test, use the existing hidden `create-test-order` route. It fixes
the server-side amount at Rs 1 (100 paise), marks the order as a test order, and does
not request WhatsApp sending. Do this only after a complete Razorpay Test Mode run.
