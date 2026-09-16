import assert from "node:assert/strict";
import test from "node:test";

import {
  collationSafeEq,
} from "../controllers/logisticsController.js";
import {
  isDelhiveryThrottledError,
  isDelhiveryWaybillMissingError,
  parseThrottleWaitMs,
} from "../services/delhiveryService.js";
import { buildShipmentStatusFlags } from "../services/delhiveryWebhookService.js";

test("collationSafeEq wraps both sides for unicode_ci comparison", () => {
  const sql = collationSafeEq("status");
  assert.match(sql, /COLLATE utf8mb4_unicode_ci/);
  assert.match(sql, /CONVERT\(\? USING utf8mb4\)/);
  assert.match(sql, /^\(status\)/);

  const loc = collationSafeEq("COALESCE(location, '')");
  assert.match(loc, /COALESCE\(location, ''\)/);
});

test("tracking status flags avoid string CASE literals", () => {
  const flags = buildShipmentStatusFlags("delivered");
  assert.equal(flags.isDelivered, 1);
  assert.equal(flags.isNdr, 0);
  assert.equal(flags.markPickedUp, 1);
});

test("parseThrottleWaitMs reads wait N seconds and Retry-After", () => {
  assert.equal(parseThrottleWaitMs("Throttled, wait 8 seconds."), 8000);
  assert.equal(
    parseThrottleWaitMs("slow down", {
      headers: { get: () => "12" },
    }),
    12000
  );
  assert.equal(parseThrottleWaitMs("no hint"), 8000);
});

test("waybill-missing and throttle classifiers", () => {
  assert.equal(
    isDelhiveryWaybillMissingError({
      message:
        "Some error has occurred. Please contact client.support@delhivery.com with error message- Data does not exists for provided Waybill(s)",
    }),
    true
  );
  assert.equal(
    isDelhiveryWaybillMissingError({ code: "DELHIVERY_WAYBILL_NOT_FOUND" }),
    true
  );
  assert.equal(isDelhiveryWaybillMissingError({ message: "collation mix" }), false);

  assert.equal(isDelhiveryThrottledError({ status: 429 }), true);
  assert.equal(isDelhiveryThrottledError({ code: "DELHIVERY_THROTTLED" }), true);
  assert.equal(
    isDelhiveryThrottledError({ message: "Throttled, wait 8 seconds." }),
    true
  );
  assert.equal(isDelhiveryThrottledError({ message: "collation" }), false);
});
