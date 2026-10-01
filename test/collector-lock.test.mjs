import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithCollectorLock } from '../scripts/collector-lock.mjs';

test('kernel collection lock accepts an old empty inode and excludes simultaneous collectors without leaving stale ownership', { skip: process.platform !== 'linux' }, async t => {
  const dir=mkdtempSync(join(tmpdir(),'mb-flock-')),lock=join(dir,'build.lock'),log=join(dir,'runs');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(lock,'');
  const script="require('fs').appendFileSync(process.argv[1],'start\\n');setTimeout(()=>require('fs').appendFileSync(process.argv[1],'done\\n'),400)";
  const run=()=>runWithCollectorLock(lock,process.execPath,['-e',script,log],{stdio:'ignore'});
  const results=await Promise.all([run(),run()]);assert.deepEqual(results.sort((a,b)=>a-b),[0,75]);
  assert.equal(await run(),0);
  assert.equal(readFileSync(log,'utf8'),'start\ndone\nstart\ndone\n');
});
