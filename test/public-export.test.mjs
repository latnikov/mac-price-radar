import test from 'node:test';
import assert from 'node:assert/strict';
import { publicContract } from '../scripts/export-public.mjs';
test('AC17 public artifact is allowlisted and excludes unapproved, stale or unsupported prices', () => {
  const now=Date.parse('2026-09-16');
  const good={id:'p1',variantId:'v1',publicTitle:'Mac',status:'approved',publishable:true,supplyConfirmed:true,salePriceMinor:10000,currency:'RUB',validUntil:'2026-09-17',supplier:'PRIVATE',purchasePriceMinor:123,token:'SECRET'};
  const result=publicContract([good,{...good,status:'draft'},{...good,validUntil:'2026-09-15'},{...good,supplyConfirmed:false}],now);
  assert.equal(result.prices.length,1);
  assert.equal(JSON.stringify(result).includes('SECRET'),false);
  assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
  assert.equal('purchasePriceMinor' in result.prices[0],false);
});
