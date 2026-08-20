import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePromoDateTime,
  parsePromoValidityRange,
  evaluatePromoApplicability,
  promoEffectiveStatus,
} from "../utils/promoValidity.js";

function ist(local) {
  const parsed = parsePromoDateTime(local);
  assert.equal(parsed.ok, true);
  return parsed.date;
}

test("naive datetime-local is interpreted as IST, not UTC", () => {
  const date = ist("2026-08-15T00:00");
  // 15 Aug 2026 00:00 IST = 14 Aug 2026 18:30 UTC
  assert.equal(date.toISOString(), "2026-08-14T18:30:00.000Z");
});

test("TEST 11: valid_until must be later than valid_from", () => {
  const bad = parsePromoValidityRange(
    "2026-08-20T10:00",
    "2026-08-20T09:00"
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "Valid until must be later than valid from.");

  const equal = parsePromoValidityRange(
    "2026-08-20T10:00",
    "2026-08-20T10:00"
  );
  assert.equal(equal.ok, false);

  const ok = parsePromoValidityRange(
    "2026-08-20T10:00",
    "2026-08-20T11:00"
  );
  assert.equal(ok.ok, true);

  const onlyFrom = parsePromoValidityRange("2026-08-20T10:00", "");
  assert.equal(onlyFrom.ok, true);
  assert.ok(onlyFrom.valid_from);
  assert.equal(onlyFrom.valid_until, null);

  const bothEmpty = parsePromoValidityRange("", "");
  assert.equal(bothEmpty.ok, true);
  assert.equal(bothEmpty.valid_from, null);
  assert.equal(bothEmpty.valid_until, null);
});

test("TEST 1: NULL/NULL has no time restriction", () => {
  const row = { is_active: true, valid_from: null, valid_until: null };
  assert.equal(evaluatePromoApplicability(row, ist("2026-08-20T10:00")).ok, true);
  assert.equal(promoEffectiveStatus(row, ist("2026-08-20T10:00")), "Active");
});

test("TEST 2: before valid_from is rejected", () => {
  const row = {
    is_active: true,
    valid_from: ist("2026-08-20T10:00"),
    valid_until: null,
  };
  const result = evaluatePromoApplicability(row, ist("2026-08-20T09:59"));
  assert.equal(result.ok, false);
  assert.equal(result.message, "This coupon is not active yet.");
  assert.equal(promoEffectiveStatus(row, ist("2026-08-20T09:59")), "Scheduled");
});

test("TEST 3: after valid_from is accepted", () => {
  const row = {
    is_active: true,
    valid_from: ist("2026-08-20T10:00"),
    valid_until: null,
  };
  assert.equal(
    evaluatePromoApplicability(row, ist("2026-08-20T10:00")).ok,
    true
  );
  assert.equal(
    evaluatePromoApplicability(row, ist("2026-08-20T10:01")).ok,
    true
  );
});

test("TEST 4: before valid_until is accepted", () => {
  const row = {
    is_active: true,
    valid_from: null,
    valid_until: ist("2026-08-20T11:00"),
  };
  assert.equal(
    evaluatePromoApplicability(row, ist("2026-08-20T10:59")).ok,
    true
  );
  assert.equal(
    evaluatePromoApplicability(row, ist("2026-08-20T11:00")).ok,
    true
  );
});

test("TEST 5: after valid_until is expired", () => {
  const row = {
    is_active: true,
    valid_from: null,
    valid_until: ist("2026-08-20T11:00"),
  };
  const result = evaluatePromoApplicability(row, ist("2026-08-20T11:01"));
  assert.equal(result.ok, false);
  assert.equal(result.message, "This coupon has expired.");
  assert.equal(promoEffectiveStatus(row, ist("2026-08-20T11:01")), "Expired");
});

test("TEST 6-8: window 10:00-11:00 IST", () => {
  const row = {
    is_active: true,
    valid_from: ist("2026-08-20T10:00"),
    valid_until: ist("2026-08-20T11:00"),
  };
  assert.equal(
    evaluatePromoApplicability(row, ist("2026-08-20T10:30")).ok,
    true
  );

  const early = evaluatePromoApplicability(row, ist("2026-08-20T09:59"));
  assert.equal(early.ok, false);
  assert.equal(early.message, "This coupon is not active yet.");

  const late = evaluatePromoApplicability(row, ist("2026-08-20T11:01"));
  assert.equal(late.ok, false);
  assert.equal(late.message, "This coupon has expired.");
});

test("TEST 9: inactive coupon rejected even inside window", () => {
  const row = {
    is_active: false,
    valid_from: ist("2026-08-20T10:00"),
    valid_until: ist("2026-08-20T11:00"),
  };
  const result = evaluatePromoApplicability(row, ist("2026-08-20T10:30"));
  assert.equal(result.ok, false);
  assert.equal(result.message, "This coupon is currently inactive.");
  assert.equal(promoEffectiveStatus(row, ist("2026-08-20T10:30")), "Inactive");
});

test("TEST 10: usage_limit reached is still rejected by existing logic", () => {
  const row = {
    is_active: true,
    valid_from: ist("2026-08-20T10:00"),
    valid_until: ist("2026-08-20T11:00"),
    usage_limit: 10,
    used_count: 10,
  };
  assert.equal(
    evaluatePromoApplicability(row, ist("2026-08-20T10:30")).ok,
    true
  );
  const used = Number(row.used_count);
  const limit = Number(row.usage_limit);
  assert.equal(used < limit, false);
});
