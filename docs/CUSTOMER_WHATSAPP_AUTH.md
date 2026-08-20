# Customer WhatsApp OTP authentication

Run `sql/add_customer_auth.sql` once against each database before deploying.
Historical orders remain unchanged. Customer ownership is resolved by normalizing
the phone stored on each order to its Indian 10-digit form.

Required backend-only environment variables:

```env
CUSTOMER_AUTH_SECRET=<at least 32 random characters>
INTERAKT_API_KEY=<existing Interakt API key>
INTERAKT_AUTH_TEMPLATE_NAME=<approved authentication template code name>
INTERAKT_AUTH_TEMPLATE_LANGUAGE=en
```

The Interakt template must be an approved Authentication template. The backend
sends the same six-digit code in `bodyValues[0]` and `buttonValues[0][0]`, as
required for Interakt copy-code/authentication templates.

For backward compatibility, deployments using `INTERAKT_OTP_TEMPLATE_NAME` and
`INTERAKT_OTP_LANGUAGE_CODE` continue to work. The `INTERAKT_AUTH_*` values take
precedence when both sets are configured.

Customer tokens are separate from admin JWTs, expire after seven days, and map to
a revocable row in `customer_sessions`. Send them as:

```http
Authorization: Bearer CUSTOMER_TOKEN
```

Invoice URLs returned by customer order APIs reuse
`GET /api/payment/invoice-download?order_id=...`; that endpoint verifies the
customer session and order ownership before returning a PDF.
