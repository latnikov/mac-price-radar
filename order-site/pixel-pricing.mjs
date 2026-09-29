// Server-only customer totals in USD, including the store's agreed costs/margin.
// Keys: '<phone id>:<storage GB>'. Populate only from an owner-approved price list.
// An absent entry means a price request, never zero, MSRP, or a made-up margin.
export const pixelCustomerTotalsUsd = Object.freeze({});
export const pixelPricingCheckedAt = null;

export function convertPixelCustomerTotal(configuration, totals, usdRub, rateAdjustmentRub) {
  const total = totals[`${configuration.phone}:${configuration.storage}`];
  if (total === undefined) return null;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(usdRub) || usdRub <= 0 || !Number.isFinite(rateAdjustmentRub) || usdRub + rateAdjustmentRub <= 0) {
    throw new Error('Не удалось рассчитать цену Pixel. Попробуйте позже.');
  }
  const price = Math.round(total * (usdRub + rateAdjustmentRub));
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error('Не удалось рассчитать цену Pixel. Попробуйте позже.');
  return price;
}
