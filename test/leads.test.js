import test from "node:test";
import assert from "node:assert/strict";
import { onlineLeadPredicate } from "../services/leads.js";
import { leadsStartEpochSeconds } from "../services/codAdvanceService.js";

test("online lead predicate: unpaid (pending/failed) non-COD orders from the start date", () => {
  const sql = onlineLeadPredicate("o").replace(/\s+/g, " ");
  assert.match(sql, /NOT \(LOWER\(TRIM\(COALESCE\(o\.payment_mode, ''\)\)\) = 'cod'/);
  assert.match(sql, /IN \('pending', 'failed'\)/);
  assert.match(sql, new RegExp(`UNIX_TIMESTAMP\\(o\\.created_at\\) >= ${leadsStartEpochSeconds()}\\)`));
  assert.doesNotMatch(sql, /'paid'/);
});

test("online lead predicate uses the given table alias", () => {
  const sql = onlineLeadPredicate("x");
  assert.match(sql, /x\.payment_status/);
  assert.doesNotMatch(sql, /\bo\./);
});
