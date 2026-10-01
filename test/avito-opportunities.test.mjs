import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePrivatePeerOpportunities as calculateAvitoOpportunities } from '../scripts/avito-opportunities.mjs';
import { AVITO } from '../scripts/avito-policy.mjs';

const at = '2026-09-30T12:00:00.000Z', now = Date.parse(at);
const avito = (id = 1234567890, price = 80_000, extra = {}) => ({
  model: 'MacBook Air 13"', chip: 'M4', screenIn: 13, ramGb: 16, storageGb: 256, color: 'Silver',
  cpuCores: 10, gpuCores: 8, condition: 'used', marketplaceSellerType: 'private', stock: 'InStock',
  priceType: 'full', currency: 'RUB', minimumQuantity: 1, fetchedAt: at, observedAt: at,
  retailer: AVITO, sourceType: 'marketplace', listingId: `avito:${id}`, externalId: String(id),
  marketplaceSellerId: `person:${id}`, sellerName: 'Алексей', sourceCity: 'Нижний Новгород',
  url: `https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_${id}`, price,
  title: 'MacBook Air 13 M4 16/256 Silver', ...extra,
});
const peers = () => [avito(1234567891, 100_000), avito(1234567892, 110_000), avito(1234567893, 115_000)];
const market = (target = avito(), evidence = peers(), options = {}) => calculateAvitoOpportunities([target, ...evidence], { now, ...options });

test('phone peer opportunities keep known SIM and region groups separate with no laptop characteristics', () => {
  const phone = { model: 'iPhone 17 Pro', chip: null, screenIn: null, ramGb: null, cpuCores: null, gpuCores: null, storageGb: 256, simType: 'eSIM', region: 'US', color: 'Silver' };
  const target = avito(undefined, 80000, phone), evidence = peers().map(item => ({ ...item, ...phone }));
  const result = market(target, evidence);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].simType, 'eSIM');
  assert.ok(!result.candidates[0].reviewReasons.some(reason => /CPU|GPU/.test(reason)));
  for (const extra of [{ simType: 'Dual SIM' }, { region: 'EU' }, { simType: 'unknown' }, { region: 'unknown' }]) {
    const different = [...evidence]; different[2] = { ...different[2], ...extra };
    assert.equal(market(target, different).candidates.length, 0, JSON.stringify(extra));
  }
});

test('used baseline uses lowest of three other private sellers and deducts costs without claiming profit', () => {
  const result = market(), candidate = result.candidates[0];
  assert.equal(candidate.referencePrice, 100_000);
  assert.equal(candidate.grossDeltaRub, 20_000);
  assert.equal(candidate.deltaRub, 17_000);
  assert.equal(candidate.deltaPercent, 17);
  assert.equal(candidate.peerCount, 3);
  assert.equal(candidate.shopCount, 0);
  assert.equal(candidate.evidence[0].marketplaceSellerId, 'person:1234567891');
  assert.ok(candidate.evidence.every(x => x.condition === 'used' && x.marketplaceSellerType === 'private'));
  assert.equal(candidate.alertEligible, true);
  assert.equal(candidate.requiresReview, true);
  assert.equal(candidate.comparisonKind, 'used-asking-price-spread');
  assert.match(candidate.comparisonNote, /не состоявшихся сделок/);
  assert.match(result.note, /не является гарантированной/);
});

test('thresholds apply after costs and percent uses conservative reference', () => {
  assert.equal(market(avito(undefined, 88_000)).candidates.length, 0);
  assert.equal(market(avito(undefined, 87_000)).candidates.length, 1);
  for (const options of [{minDeltaRub: 18_000}, {minDeltaPercent: 18}, {costReserveRub: 12_000}])
    assert.equal(market(undefined, undefined, options).candidates.length, 0);
  assert.equal(market(avito(undefined, 98_999.99), undefined, {minDeltaRub: 1_000.01, minDeltaPercent: 0, costReserveRub: 0}).candidates[0].deltaRub, 1_000.01);
});

test('three OTHER independent private sellers are mandatory; retail and company prices never count', () => {
  assert.equal(market(undefined, peers().slice(0, 2)).candidates.length, 0);
  for (const extra of [{marketplaceSellerType: 'company'}, {condition: 'new'}, {retailer: 'Айфория', sourceType: 'website'},
    {marketplaceSellerType: undefined}, {sellerName: 'Магазин Apple'}, {matchedRetailer: 'Айфория'}]) {
    const items = peers(); items[2] = {...items[2], ...extra};
    assert.equal(market(undefined, items).candidates.length, 0, JSON.stringify(extra));
    assert.equal(market(avito(undefined, undefined, extra)).candidates.length, 0, JSON.stringify(extra));
  }
});

test('multiple listings from one seller and the candidate own listings do not inflate baseline', () => {
  const items = peers(); items[2].marketplaceSellerId = items[1].marketplaceSellerId;
  assert.equal(market(undefined, items).candidates.length, 0);
  const own = avito(1234567894, 120_000, {marketplaceSellerId: avito().marketplaceSellerId});
  assert.equal(market(undefined, [...peers().slice(0,2), own]).candidates.length, 0);
  const low = avito(1234567894, 99_000, {marketplaceSellerId: peers()[0].marketplaceSellerId});
  const candidate = market(undefined, [...peers(), low]).candidates[0];
  assert.equal(candidate.peerCount, 3);
  assert.equal(candidate.referencePrice, 99_000);
});

test('configuration, color, CPU/GPU and commercial differences are never silently compared', () => {
  for (const extra of [{color:'Midnight'}, {ramGb:24}, {storageGb:512}, {chip:'M3'}, {model:'MacBook Pro 13"'},
    {screenIn:15}, {cpuCores:12}, {gpuCores:10}, {condition:'new'}, {priceType:'installment'}, {currency:'USD'}]) {
    const items=peers(); items[2]={...items[2],...extra};
    assert.equal(market(undefined, items).candidates.length,0,JSON.stringify(extra));
  }
  const items=peers(); items[2].keyboard='RU';
  assert.equal(market(avito(undefined,undefined,{keyboard:'US'}),items).candidates.length,0);
  assert.equal(market(avito(undefined,undefined,{storageGb:1024}),peers().map(x=>({...x,storageGb:1000}))).candidates.length,1);
});

test('missing core counts remain explicit inspection leads without invented specifications', () => {
  const candidate=market(avito(undefined,undefined,{cpuCores:null})).candidates[0];
  assert.match(candidate.reviewReasons.join(' '),/Проверить число ядер/);
  assert.equal(candidate.alertEligible,true);
  assert.equal(market(avito(undefined,undefined,{color:'unknown'})).candidates.length,0);
});

test('both target and peers must be current, working and accepted', () => {
  const invalid=[{observedAt:'2026-09-30T07:59:59Z'},{observedAt:'2026-09-30T12:02:00Z'},
    {observedAt:'invalid'},{validUntil:at},{withdrawn:true},{active:false},{stock:'PreOrder'},
    {stock:'OutOfStock'},{stock:'unknown'},{rejected:true},{validationStatus:'rejected'},
    {latestAttempt:{rejected:true}},{latestAttempt:{status:'withdrawn'}},{visibility:'private'},
    {qualityWarnings:['Конфликт CPU']},{validationIssues:['invalid_price']},{isDemo:true},
    {price:0},{price:NaN},{price:'80000'},{minimumQuantity:2},{condition:'refurbished'}];
  for (const extra of invalid) {
    assert.equal(market(avito(undefined,undefined,extra)).candidates.length,0,JSON.stringify(extra));
    const items=peers(); items[2]={...items[2],...extra};
    assert.equal(market(undefined,items).candidates.length,0,JSON.stringify(extra));
  }
  assert.equal(market(avito(undefined,undefined,{observedAt:'2026-09-30T08:00:00Z'})).candidates.length,1);
});

test('anomalies stay inspectable but are not pushed as ordinary opportunities', () => {
  for (const extra of [{price:50_000},{previousPrice:120_000},{avitoRisks:['Условия цены требуют проверки']}]) {
    const candidate=market(avito(undefined,undefined,extra)).candidates[0];
    assert.equal(candidate.alertEligible,false);
    assert.equal(candidate.status,'needs_review');
  }
  const items=peers(); items[2].price=150_000;
  assert.equal(market(undefined,items).candidates[0].alertEligible,false);
  assert.equal(market(avito(undefined,undefined,{avitoRisks:['Товар под заказ']})).candidates.length,0);
});

test('stable ID/price deduplication and latest withdrawals win without mutating inputs', () => {
  const input=[avito(),...peers()],before=structuredClone(input);
  const result=calculateAvitoOpportunities([...input,{...input[0],listingId:'alternate'}],{now});
  assert.equal(result.candidates.length,1);
  assert.equal(result.candidates[0].dedupKey,market().candidates[0].dedupKey);
  assert.notEqual(result.candidates[0].dedupKey,market(avito(undefined,79_000)).candidates[0].dedupKey);
  assert.deepEqual(input,before);
  const withdrawn={...input[0],observedAt:'2026-09-30T12:00:30Z',stock:'Discontinued'};
  for (const records of [[...input,withdrawn],[withdrawn,...input]]) assert.equal(calculateAvitoOpportunities(records,{now}).candidates.length,0);
});

test('own sellers, wrong cities and untrusted URLs are excluded', () => {
  for (const extra of [{sellerName:'Макбучная'},{matchedRetailer:'MacBookBro'},{sourceCity:'Москва'},
    {marketplaceSellerId:''},{url:'https://evil.example/macbook_1234567890'},{externalId:'9999999999'}])
    assert.equal(market(avito(undefined,undefined,extra)).candidates.length,0,JSON.stringify(extra));
});

test('invalid calculation options fail clearly', () => {
  for (const options of [{now:NaN},{minDeltaRub:-1},{minDeltaRub:'1000'},{minDeltaPercent:101},
    {maxAgeHours:0},{costReserveRub:0.001}]) assert.throws(()=>market(undefined,undefined,options),TypeError);
  assert.throws(()=>calculateAvitoOpportunities(null),TypeError);
  assert.equal(calculateAvitoOpportunities([null,false,{}],{now}).candidates.length,0);
});
