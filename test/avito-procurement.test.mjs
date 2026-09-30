import test from 'node:test';
import assert from 'node:assert/strict';
import { rankAvitoOffers } from '../scripts/avito-ranking.mjs';
import { russianProcurementOffers } from '../scripts/avito-procurement.mjs';
import { calculateAvitoOpportunities } from '../scripts/avito-opportunities.mjs';
const now=Date.parse('2026-10-01T00:00:00Z'),at=new Date(now).toISOString();
const listing=(id=1234567890,price=80000,extra={})=>({
  retailer:'Авито НН',sourceCity:'Нижний Новгород',marketplaceSellerType:'private',marketplaceSellerId:`seller:${id}`,sellerName:'Алексей',
  listingId:`avito:${id}`,externalId:String(id),url:`https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_${id}`,
  title:'MacBook Air 13 M4 16/256 Silver',model:'MacBook Air 13"',chip:'M4',screenIn:13,ramGb:16,storageGb:256,color:'Silver',
  cpuCores:10,gpuCores:8,currency:'RUB',price,priceType:'full',stock:'source_reported',condition:'used',observedAt:at,fetchedAt:at,...extra});
const quote=(retailer='BSA',price=100000,extra={})=>({...listing(),retailer,listingId:`quote:${retailer}`,condition:'new',sourceType:'telegram_channel',price,...extra});
const rank=(target=listing(),quotes=[quote()],options={})=>rankAvitoOffers([target,...quotes],{now,...options})[0].avitoRank;

test('Russian procurement ranking uses the minimum matching Дима/BSA quote and integer money',()=>{
  const r=rank(listing(),[quote(),quote('Дима',99000),quote('Айфория',50000)]);
  assert.equal(r.referencePrice,99000);assert.equal(r.procurement.retailer,'Дима');assert.equal(r.grossDeltaRub,19000);
  assert.equal(r.deltaRub,16000);assert.equal(r.comparisonKind,'russian-procurement-gap');assert.equal(r.alertEligible,true);
  assert.match(r.reasons.join(' '),/Б\/у сравнивается с закупом нового/);
  assert.equal(rank(listing(undefined,79999.99)).deltaRub,17000.01);
});
test('rankings include negative gaps and unmatched cards without inventing a procurement price',()=>{
  const offers=[listing(1234567890,105000),listing(1234567891,80000),listing(1234567892,70000,{chip:'M1'}),quote()];
  const before=structuredClone(offers),r=rankAvitoOffers(offers,{now});
  assert.equal(r[1].avitoRank.position,1);assert.equal(r[0].avitoRank.position,2);assert.equal(r[2].avitoRank.position,3);
  assert.equal(r[0].avitoRank.deltaRub,-8000);assert.equal(r[2].avitoRank.referencePrice,null);assert.deepEqual(offers,before);
});
test('configuration mismatch, expired procurement, stores, demo prices and commercial terms cannot be the baseline',()=>{
  for(const extra of [{chip:'M5'},{ramGb:24},{storageGb:512},{screenIn:15},{model:'MacBook Pro 13"'},
    {cpuCores:12},{gpuCores:10},{currency:'USD'},{price:'100000'},{condition:'used'},{priceType:'installment'},
    {minimumQuantity:2},{stock:'OutOfStock'},{validUntil:at},{observedAt:new Date(now-73*3600000).toISOString()},
    {observedAt:new Date(now+120000).toISOString()},{qualityWarnings:['conflict']},{latestAttempt:{rejected:true}},
    {visibility:'private'},{dataKind:'demo'},{rejected:true}])assert.equal(rank(undefined,[quote('BSA',100000,extra)]).referencePrice,null,JSON.stringify(extra));
  assert.equal(rank(undefined,[quote('BigGeek')]).referencePrice,null);
  assert.equal(rank(undefined,[quote('Telegram:-123')]).referencePrice,null);
  assert.equal(rank(undefined,[quote('Telegram:-123',100000,{procurementApproved:true})]).referencePrice,100000);
});
test('latest withdrawal never resurrects an older low quote; other colors are explicit review-only comparisons',()=>{
  const old=quote('BSA',90000,{observedAt:new Date(now-60000).toISOString()}),withdrawn=quote('BSA',100000,{stock:'OutOfStock'});
  assert.equal(russianProcurementOffers([old,withdrawn],{now}).length,0);
  const r=rank(undefined,[quote('BSA',90000,{color:'Midnight'})]);assert.equal(r.referencePrice,90000);
  assert.equal(r.matchKind,'other_color');assert.equal(r.alertEligible,false);assert.match(r.reasons.join(' '),/Цвет не совпадает/);
});
test('procurement alerts require fresh private used cards, matching configuration and the net threshold',()=>{
  const calculate=(target=listing(),quotes=[quote()])=>calculateAvitoOpportunities([target,...quotes],{now});
  const candidate=calculate().candidates[0];assert.equal(candidate.deltaRub,17000);assert.equal(candidate.peerCount,0);
  assert.equal(candidate.comparisonKind,'russian-procurement-gap');assert.equal(candidate.alertEligible,true);
  for(const extra of [{condition:'new'},{marketplaceSellerType:'company'},{sourceCity:'Москва'},
    {observedAt:new Date(now-5*3600000).toISOString()},{price:89000},{marketplaceSellerId:''},{color:'unknown'}])
    assert.equal(calculate(listing(undefined,undefined,extra)).candidates.length,0,JSON.stringify(extra));
  assert.equal(calculate(listing(undefined,50000)).candidates[0].alertEligible,false);
  assert.equal(calculate(undefined,[quote('BSA',100000,{color:'Midnight'})]).candidates[0].alertEligible,false);
});
