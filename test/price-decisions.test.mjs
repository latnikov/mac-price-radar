import test from 'node:test';
import assert from 'node:assert/strict';
import { openMasterStore } from '../scripts/master-store.mjs';
import { publicContract } from '../scripts/export-public.mjs';
const quote={id:'q1',actor:'buyer',reason:'confirmed by supplier',supplier:'Private supplier',title:'Exact SKU',unitPriceMinor:9000000,currency:'RUB',quantity:1,availableQuantity:2,validUntil:'2099-01-01',confirmedAt:'2026-09-15',destination:'NN',origin:'Moscow',deliveryDays:1,deliveryMinor:150000,paymentMethod:'bank',documents:'invoice',warranty:'1 year',condition:'new',variantId:'v1',matchStatus:'exact',variant:{model:'MacBook Air 13',chip:'M4',cpuCores:10,gpuCores:10,ramGb:16,storageGb:512,screenIn:13,color:'Silver',keyboard:'US',region:'US',displayType:'standard',bundle:'standard'},variantConfirmation:{confirmed:true,actor:'buyer',reason:'checked',evidence:'SKU proof',confirmedAt:'2026-09-15'}};
const calc={actor:'buyer',reason:'scenario',quoteId:'q1',currency:'RUB',quantity:1,destination:'NN',costBasis:'supplier quote + documented costs',taxPolicyConfirmed:true,salePriceMinor:11000000,purchasePriceMinor:9000000,inboundDeliveryMinor:150000,inspectionMinor:50000,salesCommissionMinor:0,expectedLossMinor:0,advertisingMinor:0,otherAcquisitionMinor:0,otherVariableMinor:0,taxMinor:0,fixedCostMinor:0,minimumContributionMinor:100000,minimumMarginBps:100};
test('approval is linked to exact confirmed supply and immutable economics, renewed quote revokes export eligibility',t=>{
  const s=openMasterStore(':memory:');t.after(()=>s.close());s.saveQuote(quote);const c=s.saveCalculation(calc);
  const input={actor:'owner',reason:'approved margin',publicTitle:'MacBook',quoteId:'q1',calculationId:c.id,variantId:'v1',validUntil:'2098-12-31',status:'approved'};
  const decision=s.savePriceDecision(input);assert.equal(decision.publishable,true);assert.equal(publicContract(s.listPriceDecisions()).prices.length,1);
  assert.throws(()=>s.savePriceDecision({...input,publicTitle:'Wrong variant',variantId:'v2'}),/approval blocked/);
  const wrong=s.saveCalculation({...calc,purchasePriceMinor:10000});assert.throws(()=>s.savePriceDecision({...input,calculationId:wrong.id}),/mismatch:quoteCalculation/);
  s.saveQuote({...quote,expectedVersion:1,unitPriceMinor:9100000});assert.equal(s.listPriceDecisions()[0].publishable,false);assert.equal(publicContract(s.listPriceDecisions()).prices.length,0);
});

test('an assertion alone cannot confirm a variant whose attributes are missing',t=>{
  const s=openMasterStore(':memory:');t.after(()=>s.close());
  const result=s.saveQuote({...quote,variant:undefined});
  assert.equal(result.status,'draft');assert.ok(result.blockers.includes('unconfirmed:variantAttributes'));
});
