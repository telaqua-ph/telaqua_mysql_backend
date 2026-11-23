import assert from "node:assert/strict";
import test from "node:test";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-farmer-intel";
const { signFarmerIntelToken, verifyFarmerIntelToken } = await import("../services/farmerIntelAuth.js");
const { requireAuth } = await import("../middleware/auth.js");
const { requireFarmerIntelLogin } = await import("../middleware/adminPermissions.js");
const { signToken } = await import("../lib/auth.js");

function fakeRes() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test("farmer intel token round-trips and is typed", () => {
  const token = signFarmerIntelToken({ userId: 3, adminId: 2 });
  const payload = verifyFarmerIntelToken(token);
  assert.equal(payload.fi_user_id, 3);
  assert.equal(payload.admin_id, 2);
});

test("an admin login token is not accepted as a Farmer Intel token", () => {
  assert.throws(() => verifyFarmerIntelToken(signToken({ admin_id: 2, email: "a@b.c" })));
});

test("a Farmer Intel token cannot be used as an admin login token", () => {
  const req = { headers: { authorization: `Bearer ${signFarmerIntelToken({ userId: 3, adminId: 2 })}` } };
  const res = fakeRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test("map routes are locked (403, not 401) without the Farmer Intel token", async () => {
  const res = fakeRes();
  let called = false;
  await requireFarmerIntelLogin()({ headers: {}, user: { admin_id: 2 } }, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "FARMER_INTEL_LOGIN_REQUIRED");
});

test("a Farmer Intel token issued to another admin session is rejected", async () => {
  const res = fakeRes();
  const token = signFarmerIntelToken({ userId: 3, adminId: 9 });
  await requireFarmerIntelLogin()({ headers: { "x-farmer-intel-token": token }, user: { admin_id: 2 } }, res, () => {});
  assert.equal(res.statusCode, 403);
});

test("map opens for any logged-in admin when the separate login is off (default)", async () => {
  const { farmerIntelAccess } = await import("../middleware/adminPermissions.js");
  delete process.env.FARMER_INTEL_LOGIN_REQUIRED;
  const req = { headers: {}, user: { admin_id: 3 } };
  let called = false;
  await farmerIntelAccess()(req, fakeRes(), () => { called = true; });
  assert.equal(called, true);
  assert.deepEqual(req.farmerIntelPermissions, { canViewCustomerData: true, canManageCouriers: true });
});

test("FARMER_INTEL_LOGIN_REQUIRED=true brings the lock back", async () => {
  const { farmerIntelAccess } = await import("../middleware/adminPermissions.js");
  process.env.FARMER_INTEL_LOGIN_REQUIRED = "true";
  const res = fakeRes();
  let called = false;
  await farmerIntelAccess()({ headers: {}, user: { admin_id: 3 } }, res, () => { called = true; });
  delete process.env.FARMER_INTEL_LOGIN_REQUIRED;
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "FARMER_INTEL_LOGIN_REQUIRED");
});
