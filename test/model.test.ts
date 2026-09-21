import test from 'node:test';
import assert from 'node:assert/strict';
import { cheapest, key, type Offer } from '../src/model.js';
test('CLI uses the same exact identity and fresh market eligibility as the master table',()=>{
  const a: Offer={retailer:'a',title:'',url:'https://example.test/a',price:100000,currency:'RUB',fetchedAt:new Date().toISOString(),condition:'new',model:'Air',chip:'M4',ramGb:16,storageGb:256,cpuCores:10,gpuCores:8,screenIn:13,color:'Silver',keyboard:'US',region:'US',displayType:'standard',bundle:'standard',priceType:'full',paymentMethod:'cash',buyerType:'retail',minimumQuantity:1,stock:'InStock'};
  const b={...a,retailer:'b',price:90000};
  const c={...a,retailer:'c',condition:'used' as const,price:10000};
  const x=cheapest([a,b,c]); assert.equal(x.length,1); assert.equal(x[0].best.retailer,'b'); assert.equal(key(a),key(b));
  assert.notEqual(key(a),key({...a,gpuCores:10}));
  assert.equal(cheapest([{...a,keyboard:'unknown'}]).length,0);
});
