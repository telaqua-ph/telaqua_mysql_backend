# telaqua-api

Production-ready REST API for **Tel-Aqua**, deployed as Vercel Serverless Functions.

Consumed by:

1. **Customer website** — HTML, CSS, and JavaScript  
2. **Admin dashboard** — React + Vite  

## Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js (ES modules) |
| Hosting | Vercel Serverless Functions |
| Database | Vercel Postgres (`@vercel/postgres`) |
| Auth | JWT (`jsonwebtoken` + `bcryptjs`) |
| Validation | Zod |

## Project structure

```
telaqua-api/
├── api/                  # Serverless route handlers
│   ├── auth/             # Authentication endpoints
│   ├── orders/           # Order CRUD
│   ├── products/         # Product catalog
│   ├── customers/        # Customer management
│   └── dashboard/        # Admin analytics
├── lib/                  # Shared core utilities (db, auth, response)
├── middleware/           # Request middleware (auth guards)
├── utils/                # Validation, helpers, constants
├── .env.example
├── package.json
├── vercel.json
└── README.md
```

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in Postgres credentials (from the Vercel dashboard after linking a Postgres store) and a `JWT_SECRET`.

### 3. Link to Vercel & Postgres

```bash
npx vercel link
npx vercel env pull .env.local
```

Or create a Postgres database in the Vercel dashboard and attach it to this project.

### 4. Run locally

```bash
npm run dev
```

API base URL locally: `http://localhost:3000/api`

### 5. Deploy

```bash
npm run deploy
```

## API routes (planned)

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Admin / user login |
| `GET` | `/api/products` | List products |
| `GET` | `/api/products/:id` | Get product by ID |
| `POST` | `/api/products` | Create product (admin) |
| `PUT` | `/api/products/:id` | Update product (admin) |
| `DELETE` | `/api/products/:id` | Delete product (admin) |
| `GET` | `/api/orders` | List orders |
| `GET` | `/api/orders/:id` | Get order by ID |
| `POST` | `/api/orders` | Create order |
| `GET` | `/api/customers` | List customers (admin) |
| `GET` | `/api/customers/:id` | Get customer by ID |
| `POST` | `/api/customer/auth/request-otp` | Send customer WhatsApp OTP |
| `POST` | `/api/customer/auth/verify-otp` | Verify OTP and create customer session |
| `POST` | `/api/customer/auth/logout` | Revoke customer session |
| `GET` | `/api/customer/profile` | Authenticated customer profile |
| `GET` | `/api/customer/orders` | Authenticated customer's order history |
| `GET` | `/api/customer/orders/recent` | Authenticated customer's recent active order |
| `GET` | `/api/customer/orders/:orderId` | Authenticated customer's owned order |
| `GET` | `/api/customer/orders/:orderId/tracking` | Owned-order AWB from Neon (no live Delhivery tracking) |
| `GET` | `/api/dashboard/stats` | Dashboard metrics (admin) |

> Handlers currently contain placeholders only. Business logic will be added next.

## Farmer Intel Map

Run `npm run migrate:farmer-intel` against the Tel-Aqua MySQL database to create the map tables and seed pincode centroid lookups. The seed contains only pincode, district/state, and approximate centroid coordinates; `INSERT IGNORE` preserves any existing curated coordinate rows. It contains no order snapshots or customer details. Map summaries continue to aggregate live orders from the database.

The `/api/admin/farmer-intel` routes, including `GET /basemap`, require an authenticated active admin with `can_view_farmer_intel_map`. Grant that permission explicitly after the migration. The basemap response contains India and state boundary geometry only.

## CORS

Configure allowed front-end origins via `CORS_ORIGINS` in `.env`. Default CORS headers are also set in `vercel.json` for development.

## License

UNLICENSED — private Tel-Aqua project.
