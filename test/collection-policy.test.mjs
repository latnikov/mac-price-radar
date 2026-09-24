import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCollection, knownProductUrls, summarizeCollectionErrors } from '../scripts/collection-policy.mjs';
const previous=Array.from({length:100},(_,i)=>({url:`https://a.test/${i}`,price:100000,currency:'RUB'}));
test('AC06 one parsed item is not a successful 100-item source refresh',()=>{
  const result=assessCollection(previous,[previous[0]]);
  assert.equal(result.status,'degraded');assert.equal(result.counts.published,0);assert.equal(result.observations[0].validationStatus,'rejected');
});
test('price collapse is retained as rejected evidence, never an automatic bargain',()=>{
  const result=assessCollection([previous[0]],[{...previous[0],price:50000}]);
  assert.equal(result.observations[0].validationStatus,'rejected');assert.match(result.observations[0].qualityWarnings.join(),/Аномальное/);
});
test('failure and partial crawl have distinct states',()=>{
  assert.equal(assessCollection(previous,[],['HTTP 503']).status,'failed');
  assert.equal(assessCollection(previous,previous.slice(0,70),['Timeout']).status,'partial');
});
test('coverage counts unique cards, not repeated observations or commercial profiles',()=>{
  const duplicates=previous.flatMap(o=>[o,{...o,priceType:'full'},{...o,url:o.url+'/?utm_source=mail'}]);
  const result=assessCollection(duplicates,previous);
  assert.equal(result.status,'success');assert.equal(result.counts.previous,100);assert.equal(result.counts.parsed,100);
  assert.equal(assessCollection(previous,Array(100).fill(previous[0])).status,'degraded');
});
test('discovery retains rejected and unpriced known cards without using private or foreign URLs',()=>{
  const card={retailer:'BigGeek',url:'https://biggeek.ru/products/macbook',currency:'RUB',validationStatus:'rejected'};
  const urls=knownProductUrls([card,{...card,url:card.url+'/?utm_source=x'}, {...card,url:card.url+'-no-price',price:null}, {...card,url:card.url+'-private',visibility:'private'}, {...card,url:'https://biggeek.ru.evil.test/products/macbook'}],'BigGeek');
  assert.deepEqual([...urls],[card.url,card.url+'-no-price']);
});
test('repeated HTTP failures are summarized without dumping product URLs',()=>{
  const summary=summarizeCollectionErrors([
    'HTTP 503: https://iphoriya.ru/product/one',
    'HTTP 503: https://iphoriya.ru/product/two',
    'HTTP 429: https://iphoriya.ru/product/three',
  ]);
  assert.equal(summary,'Магазин временно отклонил запросы: 2 (HTTP 503); Магазин ограничил частоту запросов: 1 (HTTP 429)');
  assert.doesNotMatch(summary,/iphoriya|product/);
});
