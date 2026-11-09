import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRemote, evidencePayload } from './jpb-output.mjs';
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

function sshResponse(chunks, code = 0) {
 let kills = 0;
 const remote = createRemote({ 'jpb-read.py': '', 'jpb-invoke-program.py': '', 'jpb-write.py': '' }, () => {
   const child = new EventEmitter();
   child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
   child.kill = () => { kills++; return false; };
   child.stdin.on('finish', () => {
     for (const chunk of chunks) child.stdout.write(chunk);
     child.stdout.end(); child.emit('close', code);
   });
   return child;
 });
 return { remote, kills: () => kills };
}

for (const script of ['jpb-read.py', 'jpb-invoke-program.py']) {
 for (const split of ['accent', 'bytewise']) {
   test(`SSH ${script} preserves Unicode across ${split} stdout chunks`, async () => {
     const row = { operation: 'Ébavurer', material: 'Pièce – € 🛠️', combining: 'e\u0301' };
     const expected = script === 'jpb-read.py' ? { records: [row] } : { outputs: [row] };
     const bytes = Buffer.from(JSON.stringify(expected));
     const at = bytes.indexOf(Buffer.from('É')) + 1;
     const chunks = split === 'accent' ? [bytes.subarray(0, at), bytes.subarray(at)]
       : Array.from(bytes, (_, index) => bytes.subarray(index, index + 1));
     const f = sshResponse(chunks);
     assert.deepEqual(await f.remote({}, script), expected);
     assert.equal(f.kills(), 0);
   });
 }
}

test('SSH response limit counts bytes and accepts exactly 2 MiB of Unicode JSON', async () => {
 const limit = 2 * 1024 * 1024, seed = { value: 'É🛠️' };
 const expected = { value: seed.value + 'a'.repeat(limit - Buffer.byteLength(JSON.stringify(seed))) };
 const bytes = Buffer.from(JSON.stringify(expected));
 assert.equal(bytes.length, limit);
 const at = bytes.indexOf(Buffer.from('É')) + 1;
 const f = sshResponse([bytes.subarray(0, at), bytes.subarray(at)]);
 assert.deepEqual(await f.remote({}), expected);
 assert.equal(f.kills(), 0);
});

test('SSH response beyond 2 MiB is rejected even if a successful exit races the kill', async () => {
 const limit = 2 * 1024 * 1024;
 const value = 'É'.repeat((limit - Buffer.byteLength(JSON.stringify({ value: '' }))) / 2);
 const bytes = Buffer.from(JSON.stringify({ value }));
 assert.equal(bytes.length, limit);
 const f = sshResponse([bytes, Buffer.from(' ')]);
 await assert.rejects(f.remote({}), { code: 'JPB_OUTPUT_UNCONFIRMED' });
 assert.equal(f.kills(), 1);
});

test('SSH invalid JSON and nonzero exits cannot return a receipt', async () => {
 await assert.rejects(sshResponse([Buffer.from('{')]).remote({}), /Invalid JPB receipt/);
 await assert.rejects(sshResponse([Buffer.from('{"ok":true}')], 1).remote({}, 'jpb-read.py'), /JPB read unavailable/);
});
