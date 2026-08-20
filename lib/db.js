/**
 * lib/db.js
 *
 * Re-exports the shared MySQL pool for backwards-compatible imports.
 * Prefer importing from config/db.js in new code.
 */

export { query, pool, isDatabaseConfigured } from "../config/db.js";
