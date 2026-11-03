import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidencePayload } from './jpb-output.mjs';
const receipt={persisted:true,readbackVerified:true,executionIri:'urn:execution:1',kaRef:'urn:workflow:1',output:{ok:true,itemsJson:JSON.stringify([{workbook:{allocationStatus:'unconfirmed',quantity:null,evidence:{contentDigest:'a'.repeat(64)}}}])}};
test('evidence is deterministic, preserves missing values and explicitly records non-calculated scope',()=>{
 const a=evidencePayload(receipt);assert.deepEqual(a,evidencePayload(receipt));
 const payload=JSON.parse(JSON.parse(a.quads.find(q=>q.predicate.endsWith(':payload')).object));
 assert.equal(payload.plcaCalculated,false);assert.equal(payload.allocationStatus,'unconfirmed');assert.equal(JSON.parse(payload.receipt.output.itemsJson)[0].workbook.quantity,null);
 assert.notEqual(a.name,evidencePayload({...receipt,executionIri:'urn:execution:2'}).name);
});
test('unverified, failed and non-JPB outputs cannot be written',()=>{
 for(const r of [{...receipt,readbackVerified:false},{...receipt,output:{ok:false}},{...receipt,output:{ok:true,itemsJson:'[{"erp":{"evidence":{"contextGraphId":"kam"}}}]'}}])assert.throws(()=>evidencePayload(r));
});

test('SSH transport pins script bytes and rejects unknown scripts without spawning', async () => {
 const { createRemote } = await import('./jpb-output.mjs');
 const { EventEmitter } = await import('node:events');
 const { PassThrough } = await import('node:stream');
 const scripts = { 'jpb-read.py': 'print("reviewed")' }, calls = [];
 const remote = createRemote(scripts, (...args) => {
   calls.push(args);
   const child = new EventEmitter();
   child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
   let input = ''; child.stdin.on('data', b => { input += b; });
   child.stdin.on('finish', () => {
     assert.ok(input.endsWith('print("reviewed")'));
     child.stdout.write('{"ok":true}'); child.emit('close', 0);
   });
   return child;
 });
 scripts['jpb-read.py'] = 'print("changed after approval")';
 assert.deepEqual(await remote({}, 'jpb-read.py'), { ok: true });
 assert.throws(() => remote({}, '../other.py'), /Unknown/);
 assert.equal(calls.length, 1);
});
