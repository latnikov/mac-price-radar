// Isolated architectural audit probes: no network or production data.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMasterStore } from '../../scripts/master-store.mjs';
import { parseDimaMessages } from '../../scripts/dima.mjs';
import { parseAfmProducts } from '../../scripts/afmcenter.mjs';
import { buildRecommendations, recommendationKey } from '../../storefront/prices.mjs';
import { openShopStore } from '../../storefront/core.mjs';
import { currentPrice } from '../../web/price-table.js';
const now = Date.parse('2026-09-29T12:00:00Z');
const base = {model:'MacBook Air 13', chip:'M5', screenIn:13, ramGb:16, storageGb:512, color:'Silver', condition:'new', retailer:'AFM', price:120000, currency:'RUB', stock:'InStock', url:'https://example.org/mac', fetchedAt:new Date(now).toISOString()};
const rejected = {...base, rejected:true, validationStatus:'rejected', priceType:'installment', minimumQuantity:5};
assert.equal(currentPrice(rejected, now), false);
assert.equal(buildRecommendations([rejected], {now})[0].priceRub,119500);
console.log('F01: rejected installment excluded by table but shop recommends 119500');
let master = openMasterStore(':memory:');
try {
 const parsed = parseDimaMessages([
  {id:'2',date:'2026-09-29T11:00:00Z', sourceChatId:'-1003421701174',text:'MacBook MDHH4 Air 13 Sky Blue (M5, 16GB, 512GB) 2026 130000'},
  {id:'1',date:'2026-09-29T08:00:00Z', sourceChatId:'-1003421701174',text:'MacBook MDHH4 Air 13 Sky Blue (M5, 16GB, 512GB) 2026 120000'}
 ], {now});
 master.ingestRun({observations:parsed.offers});
 assert.equal(master.getOffers()[0].price,120000);
 console.log('F02: older Dima 120000 wins newer 130000');
 const preview=master.previewImport({retailer:'Audit supplier',rows:[{url:'https://example.org/usd',price:1000,currency:'USD'}]});
 assert.equal(preview.rows[0].offer.currency,'RUB'); assert.equal(preview.accepted,1);
 console.log('F04: USD 1000 accepted as RUB 1000 without conversion');
} finally {master.close();}
master=openMasterStore(':memory:');
try {
 const product=JSON.parse(readFileSync(new URL('../../test/fixtures/afm-products.json',import.meta.url)))[0];
 const before=parseAfmProducts([product],{fetchedAt:new Date(now-60000).toISOString()});
 master.ingestRun({observations:before});
 product.editions[0].price='';
 const after=parseAfmProducts([product],{fetchedAt:new Date(now).toISOString()});
 master.ingestRun({observations:after});
 assert.equal(master.getOffers().length,2);assert.equal(after.length,1);
 console.log('F03: AFM removed price still returned from last accepted observation');
}finally{master.close();}
const dir=mkdtempSync(join(tmpdir(),'architecture-audit-'));
const shop=openShopStore(join(dir,'shop.sqlite'),{now:()=>now});
try {
 shop.refreshPrices(buildRecommendations([base],{now}));
 const input={title:'Audit Mac',specification:'Original specification',recommendationKey:recommendationKey(base),mappingConfirmed:true};
 const p=shop.saveProduct(input,{publish:true});const s=shop.session();shop.setCart(s,{[p.id]:1});const checkout=shop.checkout(s);
 shop.saveProduct({...input,specification:'Changed specification'},{id:p.id,publish:true,expectedRevision:p.revision});
 const id=shop.placeOrder(s,{phone:'+79990000000',consent:'on',checkoutId:checkout.id});
 const order=JSON.parse(shop.db.prepare('SELECT data FROM orders WHERE id=?').get(id).data);
 assert.equal(order.lines[0].specification,'Changed specification');
 console.log('F05: checkout accepts changed specification without reconfirmation');
}finally{shop.close();rmSync(dir,{recursive:true,force:true});}
