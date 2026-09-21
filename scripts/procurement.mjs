import { identityFields, known, assessOffer } from './domain.mjs';
// All money in this module is expressed in integer minor units (kopecks for RUB).
export const ECONOMICS_VERSION = 'contribution-v1';

const monetaryFields = [
  'salePriceMinor', 'purchasePriceMinor', 'inboundDeliveryMinor', 'inspectionMinor',
  'salesCommissionMinor', 'expectedLossMinor', 'advertisingMinor',
  'otherAcquisitionMinor', 'otherVariableMinor', 'taxMinor', 'fixedCostMinor',
];

export function minorUnits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value * 100);
  return Number.isSafeInteger(rounded) && Math.abs(value * 100 - rounded) < 0.00001 ? rounded : null;
}

function money(value, name, blockers) {
  if (value === null || value === undefined || value === '') { blockers.push(`unknown:${name}`); return null; }
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer in minor units`);
  return value;
}

function exactNumber(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError('Monetary result exceeds safe integer range');
  return result;
}

const sum = values => values.some(v => v === null) ? null : exactNumber(values.reduce((total, value) => total + BigInt(value), 0n));
const difference = (left, ...right) => left === null || right.some(v => v === null) ? null : exactNumber(BigInt(left) - right.reduce((total, value) => total + BigInt(value), 0n));
const ceilRatio = (amount, denominator) => denominator > 0 ? exactNumber((BigInt(amount) * 10000n + BigInt(denominator) - 1n) / BigInt(denominator)) : null;
const basisPoints = (amount, base) => amount === null || base === null || base === 0 ? null : Number(BigInt(amount) * 10000n / BigInt(base));

/** A scenario is not a fact of sale, and contribution is never labelled net profit. */
export function calculateEconomics(input = {}) {
  const blockers = [];
  const currency = input.currency ?? 'RUB';
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('currency must be an ISO code');
  const quantity = input.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError('quantity must be a positive integer');
  const values = Object.fromEntries(monetaryFields.map(key => [key, money(input[key], key, blockers)]));
  const rate = input.commissionRateBps;
  if (rate !== undefined && rate !== null) {
    if (!Number.isInteger(rate) || rate < 0 || rate >= 10000) throw new TypeError('commissionRateBps must be between 0 and 9999');
    if (input.salesCommissionMinor !== undefined && input.salesCommissionMinor !== null) throw new TypeError('Specify salesCommissionMinor or commissionRateBps, not both');
    values.salesCommissionMinor = values.salePriceMinor === null ? null : exactNumber((BigInt(values.salePriceMinor) * BigInt(rate) + 5000n) / 10000n);
    const index = blockers.indexOf('unknown:salesCommissionMinor');
    if (index >= 0 && values.salesCommissionMinor !== null) blockers.splice(index, 1);
  }
  if (input.taxPolicyConfirmed !== true) blockers.push('unconfirmed:taxPolicy');
  if (!input.destination) blockers.push('unknown:destination');
  if (!input.costBasis) blockers.push('unknown:costBasis');
  if (input.exchangeRateConfirmed === false) blockers.push('unconfirmed:exchangeRate');
  const landedCostMinor = sum([values.purchasePriceMinor, values.inboundDeliveryMinor, values.inspectionMinor, values.otherAcquisitionMinor]);
  const variableCostMinor = sum([values.salesCommissionMinor, values.expectedLossMinor, values.advertisingMinor, values.otherVariableMinor]);
  const grossDeltaMinor = difference(values.salePriceMinor, landedCostMinor);
  const contributionMinor = difference(values.salePriceMinor, landedCostMinor, variableCostMinor);
  const afterTaxContributionMinor = difference(contributionMinor, values.taxMinor);
  const afterFixedCostsMinor = difference(afterTaxContributionMinor, values.fixedCostMinor);
  const minimumContributionMinor = money(input.minimumContributionMinor, 'minimumContributionMinor', blockers);
  const margin = input.minimumMarginBps;
  if (margin !== null && margin !== undefined && (!Number.isInteger(margin) || margin < 0 || margin >= 10000)) throw new TypeError('minimumMarginBps must be between 0 and 9999');
  if (margin === null || margin === undefined) blockers.push('unknown:minimumMarginBps');
  // Fixed taxes/costs supplied here are valid only for the explicitly chosen scenario base.
  const fixedForThreshold = sum([landedCostMinor, values.expectedLossMinor, values.advertisingMinor, values.otherVariableMinor, values.taxMinor, values.fixedCostMinor, rate === null || rate === undefined ? values.salesCommissionMinor : 0]);
  const denominator = 10000 - (rate ?? 0);
  const breakEvenPriceMinor = fixedForThreshold === null ? null : ceilRatio(fixedForThreshold, denominator);
  const minimumByAmountMinor = fixedForThreshold === null || minimumContributionMinor === null ? null : ceilRatio(sum([fixedForThreshold, minimumContributionMinor]), denominator);
  const minimumByMarginMinor = fixedForThreshold === null || margin === null || margin === undefined ? null : ceilRatio(fixedForThreshold, denominator - margin);
  if (margin !== null && margin !== undefined && denominator - margin <= 0) blockers.push('invalid:minimumMarginDenominator');
  const minimumSalePriceMinor = minimumByAmountMinor === null || minimumByMarginMinor === null ? null : Math.max(minimumByAmountMinor, minimumByMarginMinor);
  const meetsMinimum = minimumSalePriceMinor === null || values.salePriceMinor === null ? null : values.salePriceMinor >= minimumSalePriceMinor;
  if (meetsMinimum === false) blockers.push('below:minimumContribution');
  return {
    formulaVersion: ECONOMICS_VERSION, currency, quantity, amountsAre: 'per-unit',
    status: blockers.length ? 'scenario' : 'confirmed', blockers,
    input: structuredClone(input), landedCostMinor, variableCostMinor, grossDeltaMinor,
    markupBps: basisPoints(grossDeltaMinor, landedCostMinor), grossMarginBps: basisPoints(grossDeltaMinor, values.salePriceMinor),
    contributionMinor, contributionMarginBps: basisPoints(contributionMinor, values.salePriceMinor),
    afterTaxContributionMinor, afterFixedCostsMinor,
    totalContributionMinor: contributionMinor === null ? null : exactNumber(BigInt(contributionMinor) * BigInt(quantity)),
    breakEvenPriceMinor, minimumByAmountMinor, minimumByMarginMinor, minimumSalePriceMinor, meetsMinimum,
    publishable: blockers.length === 0 && meetsMinimum === true,
    note: 'Сценарный вклад по указанным статьям; не чистая прибыль и не факт сделки. Денежный поток учитывается отдельно.',
  };
}

export function validateQuote(input, now = new Date().toISOString()) {
  const blockers = [];
  const amount = money(input.unitPriceMinor, 'unitPriceMinor', blockers);
  if (amount === 0) blockers.push('invalid:unitPriceMinor');
  if (!input.variantId || input.matchStatus !== 'exact') blockers.push('unconfirmed:exactVariant');
  const variant = input.variant || {};
  if (identityFields.some(field => !known(variant[field])) || ['cpuCores','gpuCores','ramGb','storageGb','screenIn'].some(field => !Number.isFinite(variant[field]) || variant[field] <= 0) || assessOffer(variant).matchStatus !== 'exact') blockers.push('unconfirmed:variantAttributes');
  const confirmation = input.variantConfirmation;
  if (!confirmation || confirmation.confirmed !== true || !confirmation.actor || !confirmation.reason || !confirmation.evidence || (!Number.isFinite(Date.parse(confirmation.confirmedAt)) || Date.parse(confirmation.confirmedAt) > Date.parse(now))) blockers.push('unconfirmed:variantEvidence');
  if (!['new','used','open_box','refurbished','display'].includes(input.condition)) blockers.push('unknown:condition');
  if (!input.warranty || input.warranty === 'unknown') blockers.push('unknown:warranty');
  if (!(input.supplier || input.retailer || input.sellerId)) blockers.push('unknown:supplier');
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) blockers.push('unknown:quantity');
  if (!Number.isSafeInteger(input.availableQuantity) || input.availableQuantity < input.quantity) blockers.push('unconfirmed:availableQuantity');
  if (!input.validUntil || !Number.isFinite(Date.parse(input.validUntil))) blockers.push('unknown:validUntil');
  else if (Date.parse(input.validUntil) <= Date.parse(now)) blockers.push('expired:validUntil');
  if (!input.confirmedAt || !Number.isFinite(Date.parse(input.confirmedAt))) blockers.push('unknown:confirmedAt');
  else if (Date.parse(input.confirmedAt) > Date.parse(now)) blockers.push('invalid:confirmedAt');
  if (!input.origin) blockers.push('unknown:origin');
  if (!input.destination) blockers.push('unknown:destination');
  if (!Number.isInteger(input.deliveryDays) || input.deliveryDays < 0) blockers.push('unknown:deliveryDays');
  if (input.deadline && (!Number.isFinite(Date.parse(input.deadline)) || Date.parse(now) + (input.deliveryDays ?? 0) * 86400000 > Date.parse(input.deadline))) blockers.push('ineligible:deadline');
  money(input.deliveryMinor, 'deliveryMinor', blockers);
  if (!input.paymentMethod || input.paymentMethod === 'unknown') blockers.push('unknown:paymentMethod');
  if (!input.documents) blockers.push('unknown:documents');
  const minimumQuantity = input.minimumQuantity ?? input.moq ?? 1;
  if (!Number.isSafeInteger(minimumQuantity) || minimumQuantity < 1 || input.quantity < minimumQuantity) blockers.push('ineligible:minimumQuantity');
  const multiple = input.quantityMultiple ?? 1;
  if (!Number.isSafeInteger(multiple) || multiple < 1 || input.quantity % multiple !== 0) blockers.push('ineligible:quantityMultiple');
  if (!/^[A-Z]{3}$/.test(input.currency ?? '')) blockers.push('unknown:currency');
  return { status: blockers.length ? 'draft' : 'confirmed', blockers };
}
