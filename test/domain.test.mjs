import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyMinor, variantKey, assessOffer } from '../scripts/domain.mjs';
import { parseProduct } from '../scripts/offer-normalization.mjs';
import { extractProductPrice } from '../scripts/structured-price.mjs';

test('AC-05 strict monetary formats reject signs, ambiguous locale, monthly strings and zero', () => {
  for (const input of ['99 990,00 ₽', '99990.00', 99990]) assert.equal(moneyMinor(input), 9999000);
  for (const input of ['99.990 ₽', '-100', '99,990', 'от 99990', '9990 /мес', 0, NaN, '99 99']) assert.equal(moneyMinor(input), null, String(input));
});
test('AC-01 cores, keyboards and region never collapse, unknown cannot claim exact', () => {
  const a={model:'Air',chip:'M5',ramGb:16,storageGb:512,screenIn:13,color:'Silver',cpuCores:10,gpuCores:8,keyboard:'US',region:'US',displayType:'standard',bundle:'standard',url:'https://a.test/a',retailer:'a'};
  for (const patch of [{gpuCores:10},{keyboard:'RU'},{region:'EU'},{keyboard:'unknown'}]) assert.notEqual(variantKey(a),variantKey({...a,...patch}));
  assert.notEqual(variantKey({...a,keyboard:'unknown'}),variantKey({...a,keyboard:'unknown',retailer:'b'}));
});
test('AC-03 legacy assumptions are unknown, explicit used stays used, contradictions retained', () => {
  const parse=title=>parseProduct(title,'https://a.test/macbook-air-13-m5-16gb-256gb-silver','a',90000);
  assert.equal(parse('MacBook Air 13 M5 16GB 512GB Silver').condition,'unknown');
  assert.equal(parse('Б/У MacBook Air 13 M5 16GB 512GB Silver').condition,'used');
  assert.equal(parse('MacBook Air 13 M5 16GB 512GB Silver').currency,'RUB');
  assert.match(parse('MacBook Air 13 M5 16GB 512GB Silver').qualityWarnings.join(),/Конфликт storage/);
});
test('AC-04 unrelated Product and installment cannot become current product price', () => {
  const product=(url,price)=>({'@type':'Product',url,name:'MacBook','offers':{'@type':'Offer',price,priceCurrency:'RUB'}});
  const html=items=>`<script type="application/ld+json">${JSON.stringify(items)}</script>`;
  assert.equal(extractProductPrice(html([product('https://a.test/a',99990),product('https://a.test/other',3000)]),'https://a.test/a').amount,99990);
  assert.ok(extractProductPrice(html([product('https://a.test/other',3000)]),'https://a.test/a').error);
  const tier=product('https://a.test/a',3000); tier.offers.priceSpecification={billingDuration:'P1M'};
  assert.ok(extractProductPrice(html([tier]),'https://a.test/a').error);
});
test('a redundant VAT price specification is the same full ruble price', () => {
  const product={'@type':'Product',url:'https://iphoriya.ru/product/macbook',name:'MacBook Air 13 M5 16GB 512GB Midnight',offers:{'@type':'Offer',url:'https://iphoriya.ru/product/macbook',price:'135900',priceCurrency:'RUB',priceSpecification:{price:'135900',priceCurrency:'RUB',valueAddedTaxIncluded:'false'}}};
  const html=`<h1>${product.name}</h1><script type="application/ld+json">${JSON.stringify(product)}</script>`;
  const parsed=extractProductPrice(html,product.url);
  assert.equal(parsed.error,undefined);
  assert.equal(parsed.amount,135900);
});
test('freshness is per observation and expired validity blocks references', () => {
  const o={fetchedAt:'2026-09-16T00:00:00Z'};
  assert.equal(assessOffer(o,{now:Date.parse('2026-09-16T05:00:00Z')}).priceStatus,'expired');
  assert.equal(assessOffer({...o,validUntil:'2026-09-15'},{now:Date.parse(o.fetchedAt)}).priceStatus,'expired');
});
test('HTML entities in a current product heading do not reduce price coverage',()=>{
  const product={'@type':'Product',name:'MacBook Pro 14" Silver & Black',offers:{'@type':'Offer',price:280990}};
  for(const heading of ['MacBook Pro 14&quot; Silver &amp; Black','MacBook Pro 14&#34; Silver &#x26; Black']){
    const html=`<h1>${heading}</h1><script type="application/ld+json">${JSON.stringify(product)}</script>`;
    const parsed=extractProductPrice(html,'https://biggeek.ru/products/macbook');
    assert.equal(parsed.amount,280990);assert.equal(parsed.metadata.currency,'RUB');
  }
});
