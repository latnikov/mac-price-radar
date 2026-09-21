import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openMasterStore } from '../scripts/master-store.mjs';
test('AC07 no-LIVE migration excludes seeds, saves historical time and never imports private prices into legacy JSON',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'master-build-'));
  try{
    await cp(resolve('scripts'),join(dir,'scripts'),{recursive:true});
    await mkdir(join(dir,'data'));await mkdir(join(dir,'apps-script'));
    await writeFile(join(dir,'apps-script/reference.gs'),'');await writeFile(join(dir,'data/catalog.json'),'[]');
    const live={retailer:'BigGeek',title:'MacBook Air 13 M5 16GB 512GB Silver',url:'https://example.test/live',price:100000,currency:'RUB',condition:'new',fetchedAt:'2026-09-15T12:00:00Z'};
    const seed={...live,url:'https://example.test/seed'};
    await writeFile(join(dir,'data/offers.json'),JSON.stringify([seed]));await writeFile(join(dir,'data/cheapest.json'),JSON.stringify([{offers:[live,seed]}]));
    const build=()=>execFileSync(process.execPath,['scripts/build-data.mjs'],{cwd:dir,env:{...process.env,LIVE:'0'},encoding:'utf8'});
    build();
    let store=openMasterStore(join(dir,'data/private/master.sqlite'));
    const offers=store.getOffers({includeRejected:true});assert.equal(offers.length,1);assert.equal(offers[0].condition,'unknown');assert.equal(Date.parse(offers[0].fetchedAt),Date.parse(live.fetchedAt));
    store.commitImport({supplier:'Private Supplier',actor:'test',reason:'fixture',rows:[{...live,url:'https://private.test/item',price:90000}]});store.close();
    build();
    const snapshot=await readFile(join(dir,'data/cheapest.json'),'utf8');assert.equal(snapshot.includes('Private Supplier'),false);assert.equal(snapshot.includes('/seed'),false);
    store=openMasterStore(join(dir,'data/private/master.sqlite'));assert.equal(store.getRuns().length,2);store.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});
