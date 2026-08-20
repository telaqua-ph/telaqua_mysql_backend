/**
 * DEPRECATED: Legacy Neon/PostgreSQL migration helper.
 * Hostinger MySQL schema is maintained separately; do not run PostgreSQL DDL here.
 *
 * Usage: node scripts/migrate-inventory.js
 */

console.error(
  "migrate-inventory.js is deprecated. Inventory tables already exist on Hostinger MySQL."
);
console.error(
  "See sql/add_inventory.sql for historical PostgreSQL reference DDL only."
);
process.exit(0);
