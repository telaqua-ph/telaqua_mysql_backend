import test from "node:test";
import assert from "node:assert/strict";
import {
  computeStockStatus,
  shouldResetLowStockAlert,
  shouldResetOutOfStockAlert,
  shouldTriggerLowStockAlert,
  shouldTriggerOutOfStockAlert,
} from "../services/inventoryService.js";

test("computeStockStatus returns IN_STOCK above threshold", () => {
  assert.equal(computeStockStatus(77, 10), "IN_STOCK");
  assert.equal(computeStockStatus(11, 10), "IN_STOCK");
});

test("computeStockStatus returns LOW_STOCK at or below threshold", () => {
  assert.equal(computeStockStatus(10, 10), "LOW_STOCK");
  assert.equal(computeStockStatus(5, 10), "LOW_STOCK");
});

test("computeStockStatus returns OUT_OF_STOCK at zero", () => {
  assert.equal(computeStockStatus(0, 10), "OUT_OF_STOCK");
});

test("low stock alert triggers only when crossing threshold downward", () => {
  assert.equal(
    shouldTriggerLowStockAlert({
      previousStock: 11,
      newStock: 10,
      threshold: 10,
      alertActive: false,
    }),
    true
  );
  assert.equal(
    shouldTriggerLowStockAlert({
      previousStock: 10,
      newStock: 9,
      threshold: 10,
      alertActive: true,
    }),
    false
  );
  assert.equal(
    shouldTriggerLowStockAlert({
      previousStock: 15,
      newStock: 12,
      threshold: 10,
      alertActive: false,
    }),
    false
  );
});

test("out of stock alert triggers once when reaching zero", () => {
  assert.equal(
    shouldTriggerOutOfStockAlert({
      previousStock: 1,
      newStock: 0,
      alertActive: false,
    }),
    true
  );
  assert.equal(
    shouldTriggerOutOfStockAlert({
      previousStock: 0,
      newStock: 0,
      alertActive: true,
    }),
    false
  );
});

test("restock resets low-stock and out-of-stock alert state", () => {
  assert.equal(shouldResetLowStockAlert(29, 10), true);
  assert.equal(shouldResetLowStockAlert(10, 10), false);
  assert.equal(shouldResetOutOfStockAlert(1), true);
  assert.equal(shouldResetOutOfStockAlert(0), false);
});
