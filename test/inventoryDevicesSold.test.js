import test from "node:test";
import assert from "node:assert/strict";
import { getInventoryDeviceCounts, getInventoryDevicesSold } from "../controllers/dashboardController.js";

test("inventory sold uses the all-time paid device quantity, not the paid order count", async () => {
  let receivedArgs;
  const onePaidOrderWithQuantityTwo = {
    devices_sold: 2,
    razorpay_paid_orders: 1,
    cod_paid_orders: 0,
  };

  const sold = await getInventoryDevicesSold(42, async (args) => {
    receivedArgs = args;
    return onePaidOrderWithQuantityTwo;
  });

  assert.deepEqual(receivedArgs, { adminId: 42, from: null, to: null });
  assert.equal(sold, 2);
});

test("inventory device counts include confirmed COD payment-pending devices", async () => {
  const counts = await getInventoryDeviceCounts(7, async () => ({
    devices_sold: 353,
    cod_pending_devices: 185,
  }));
  assert.deepEqual(counts, { paidSold: 353, codPending: 185 });
});
