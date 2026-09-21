import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEconomics, minorUnits, validateQuote } from '../scripts/procurement.mjs';

const scenario = overrides => ({ currency: 'RUB', salePriceMinor: 10000000, purchasePriceMinor: 9000000, inboundDeliveryMinor: 150000, inspectionMinor: 50000, salesCommissionMinor: 250000, expectedLossMinor: 100000, advertisingMinor: 200000, otherAcquisitionMinor: 0, otherVariableMinor: 0, taxMinor: 0, fixedCostMinor: 0, minimumContributionMinor: 200000, minimumMarginBps: 200, taxPolicyConfirmed: true, costBasis: 'AC13 illustrative scenario; no applicable taxes or fixed costs included', destination: 'NN', ...overrides });

test('AC-13 landed cost is 92000 RUB and contribution is 2500 RUB, not net profit', () => {
  const result = calculateEconomics(scenario());
  assert.equal(result.landedCostMinor, 9200000);
  assert.equal(result.grossDeltaMinor, 800000);
  assert.equal(result.contributionMinor, 250000);
  assert.equal(result.contributionMarginBps, 250);
  assert.equal(result.meetsMinimum, true);
  assert.equal(result.netProfitMinor, undefined);
});

test('unknown delivery, taxes and policy remain unknown and block confirmation', () => {
  const result = calculateEconomics(scenario({ inboundDeliveryMinor: null, taxMinor: null, taxPolicyConfirmed: false }));
  assert.equal(result.landedCostMinor, null);
  assert.equal(result.contributionMinor, null);
  assert.equal(result.afterTaxContributionMinor, null);
  assert.equal(result.status, 'scenario');
  assert.equal(result.publishable, false);
  assert.ok(result.blockers.includes('unknown:inboundDeliveryMinor'));
  assert.ok(result.blockers.includes('unconfirmed:taxPolicy'));
});

test('both amount and percent thresholds are enforced after discounts and rounding', () => {
  const result = calculateEconomics(scenario({ salesCommissionMinor: undefined, commissionRateBps: 250, minimumContributionMinor: 300000, minimumMarginBps: 400 }));
  assert.equal(result.minimumSalePriceMinor, Math.max(result.minimumByAmountMinor, result.minimumByMarginMinor));
  const justBelow = calculateEconomics(scenario({ salePriceMinor: result.minimumSalePriceMinor - 1, salesCommissionMinor: undefined, commissionRateBps: 250, minimumContributionMinor: 300000, minimumMarginBps: 400 }));
  assert.equal(justBelow.meetsMinimum, false);
  assert.equal(justBelow.publishable, false);
  const sufficient = calculateEconomics(scenario({ salePriceMinor: result.minimumSalePriceMinor, salesCommissionMinor: undefined, commissionRateBps: 250, minimumContributionMinor: 300000, minimumMarginBps: 400 }));
  assert.equal(sufficient.meetsMinimum, true);
});

test('invalid denominator, fractional kopecks and double counted commission cannot be confirmed', () => {
  const invalid = calculateEconomics(scenario({ salesCommissionMinor: undefined, commissionRateBps: 9000, minimumMarginBps: 2000 }));
  assert.equal(invalid.minimumSalePriceMinor, null);
  assert.ok(invalid.blockers.includes('invalid:minimumMarginDenominator'));
  assert.throws(() => calculateEconomics(scenario({ purchasePriceMinor: 0.5 })), /integer/);
  assert.throws(() => calculateEconomics(scenario({ commissionRateBps: 250 })), /not both/);
  assert.equal(minorUnits(99990.01), 9999001);
  assert.equal(minorUnits(99.999), null);
});

test('expired quote and MOQ discount cannot be used for one unit', () => {
  const result = validateQuote({ quantity: 1, minimumQuantity: 10, unitPriceMinor: 9000000, validUntil: '2020-01-01T00:00:00Z' });
  assert.equal(result.status, 'draft');
  assert.ok(result.blockers.includes('expired:validUntil'));
  assert.ok(result.blockers.includes('ineligible:minimumQuantity'));
});
