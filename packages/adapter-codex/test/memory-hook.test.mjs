import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('native hook command forwards only intended fields and queues failures without blocking Codex', async t => {
  const dir=mkdtempSync(join(tmpdir(),'codex-hook-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'memory')); writeFileSync(join(dir,'memory/settings.json'),JSON.stringify({nativeCapture:true}));
  writeFileSync(join(dir,'memory-hook.token'),'test-token');
  let received; let fail=false;
  const server=http.createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer test-token');
    let body=''; for await(const c of req) body+=c;
    received=JSON.parse(body); res.writeHead(fail?503:200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'Evidence'}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>server.close());
  const config=join(dir,'config.json');writeFileSync(config,JSON.stringify({port:server.address().port,stateDir:dir}));
  const run=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../src/memory-hook.mjs',import.meta.url)),config],{env:{...process.env,DKG_CODEX_SURFACE:''}});
    let stdout='';child.stdout.on('data',c=>stdout+=c);child.on('error',reject);
    child.on('exit',code=>code===0?resolve(JSON.parse(stdout)):reject(new Error('Hook exit '+code)));
    child.stdin.end(JSON.stringify({session_id:'native-a',turn_id:'turn-a',hook_event_name:'UserPromptSubmit',prompt:'Hermes',tool_input:{secret:'secret-args'},tool_response:{secret:'secret-result'},analysis:'private-reasoning'}));
  });
  assert.equal((await run()).hookSpecificOutput.additionalContext,'Evidence');
  assert.equal(received.prompt,'Hermes');assert.ok(!JSON.stringify(received).includes('secret-'));assert.ok(!JSON.stringify(received).includes('private-reasoning'));
  fail=true; assert.match((await run()).systemMessage,/queued locally/);
  const files=readdirSync(join(dir,'memory/native-outbox'));assert.equal(files.length,1);
  assert.equal(JSON.parse(readFileSync(join(dir,'memory/native-outbox',files[0]))).prompt,'Hermes');
});
