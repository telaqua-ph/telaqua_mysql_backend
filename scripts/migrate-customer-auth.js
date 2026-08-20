/**
 * DEPRECATED: Legacy Neon/PostgreSQL migration helper.
 * Customer auth tables already exist on Hostinger MySQL.
 *
 * Usage: node scripts/migrate-customer-auth.js
 */

console.error(
  "migrate-customer-auth.js is deprecated. Customer auth tables already exist on Hostinger MySQL."
);
console.error(
  "See sql/add_customer_auth.sql for historical PostgreSQL reference DDL only."
);
process.exit(0);
