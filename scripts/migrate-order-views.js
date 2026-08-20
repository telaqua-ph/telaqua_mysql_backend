/**
 * DEPRECATED: Legacy Neon/PostgreSQL migration helper.
 * Hostinger MySQL schema is maintained separately; do not run PostgreSQL DDL here.
 *
 * Usage: node scripts/migrate-order-views.js
 */

console.error(
  "migrate-order-views.js is deprecated. Order-view tables already exist on Hostinger MySQL."
);
console.error(
  "See sql/add_order_views.sql for historical PostgreSQL reference DDL only."
);
process.exit(0);
