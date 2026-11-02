/**
 * One Tel-Aqua pH meter sells at this price (MRP ₹2,999, ₹1,200 off).
 * Some orders were stored as a single line at the full amount
 * (quantity 1, unit price ₹3,598) even though that amount is two meters.
 */
export const DEVICE_SALE_PRICE = 1799;

const money = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) / 100 : null;
};

const wholeDevices = (amount, price) => {
  if (amount == null || !Number.isFinite(price) || price <= 0) return null;
  const devices = Math.round(amount / price);
  if (devices >= 1 && Math.abs(devices * price - amount) < 0.05) return devices;
  return null;
};

/**
 * Device count and per-meter price for admin and invoices.
 * A row already stored as N × ₹1,799 is left as it is.
 */
export function resolveSoldDevices(order, devicePrice = DEVICE_SALE_PRICE) {
  const price = money(devicePrice);
  const storedQty = Math.max(1, Math.round(Number(order?.quantity) || 1));
  const unit = money(order?.unit_price);
  const total = money(order?.final_total ?? order?.total_amount);
  const amount = total != null && total > 0 ? total : unit;

  if (unit != null && price != null && Math.abs(unit - price) < 0.05) {
    const fromTotal = wholeDevices(amount, price);
    if (
      fromTotal &&
      fromTotal !== storedQty &&
      Math.abs(unit * storedQty - (amount ?? 0)) > 0.05
    ) {
      return { quantity: fromTotal, unitPrice: price };
    }
    return { quantity: storedQty, unitPrice: price };
  }

  const devices = wholeDevices(amount, price);
  if (
    devices &&
    devices >= 2 &&
    storedQty === 1 &&
    unit != null &&
    amount != null &&
    Math.abs(unit - amount) < 0.05
  ) {
    return { quantity: devices, unitPrice: price };
  }

  return {
    quantity: storedQty,
    unitPrice: unit != null && unit > 0 ? unit : price,
  };
}
