import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { compileStudio, normalizeStudio, readStudio, studioProgramSource, validateStudioCapabilities } from '../../../examples/n8n-capability/studio-definition.mjs';
import { compileStudio as compileStudioV1, studioProgramSource as studioProgramSourceV1 } from '../../../examples/n8n-capability/studio-definition-v1.mjs';

import { graphId, owner, catalog, definition, environment } from '../../../examples/n8n-capability/test-support/studio-service-fixture.mjs';
const compile=v=>compileStudio(v,{graphId,owner,fixture:true,providerId:'unit_native'});

test('native graph compiles branch ports, selected sinks and a source that pins root parameters',()=>{
  const v=compile(definition()), names=v.workflow.nodes.map(n=>n.name);
  assert.ok(v.workflow.nodes.some(n=>n.type==='n8n-nodes-base.if'));
  assert.equal(v.workflow.connections['Block n1'].main[0][0].node,'Block n2 check 0');
  assert.deepEqual(v.grant.result.sinks.map(s=>[s.name,s.port]),[['n1 false',1],['n2 main',0]]);
  assert.ok(names.includes(v.grant.result.traceNodes[0]));
  assert.equal(v.workflow.nodes.some(n=>n.type==='n8n-nodes-base.code'),false);
  const source=studioProgramSource(v); assert.deepEqual(readStudio(source).definition,v.definition);
  const require=createRequire(new URL('../../../package.json',import.meta.url)),ts=require('typescript');
  const ctx={exports:{},require:()=>({invoke_tool:(_tool,input)=>input})};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,ctx);
  const input={itemsJson:'[{"name":"Ana"}]',paramsJson:JSON.stringify(v.definition.nodes[0].params),executionId:''};
  assert.equal(ctx.exports.run(input).itemsJson,input.itemsJson);
  assert.throws(()=>ctx.exports.run({...input,paramsJson:'{"fields":{"arbitrary":true}}'}));
  assert.throws(()=>ctx.exports.run({...input,executionId:'999'}));
});
test('validation rejects arbitrary cycles, unmatched joins and incompatible file edges',()=>{
  assert.throws(()=>normalizeStudio(definition(['edit-fields','limit'],[[0,0,1,0],[1,0,0,0]])),/cycle|first/);
  assert.throws(()=>normalizeStudio(definition(['edit-fields','merge'],[[0,0,1,0]])),/both inputs/);
  assert.throws(()=>normalizeStudio(definition(['edit-fields','extract-file'],[[0,0,1,0]])),/file output/);
  assert.throws(()=>normalizeStudio(definition(['edit-fields','schedule'],[[0,0,1,0]])),/event trigger/);
  const value=definition(); value.nodes[0].params.fields=JSON.parse('{"__proto__":{}}'); assert.throws(()=>normalizeStudio(value),/Reserved/);
});
test('only a bounded loop return may form a cycle and the native engine receives its actual backedge',()=>{
  const v=compile(definition(['loop-items','edit-fields','aggregate'],[[0,1,1,0],[1,0,0,0],[0,0,2,0]]));
  assert.equal(v.workflow.connections['Block n0'].main[1][0].node,'Block n1 check 0');
  assert.equal(v.workflow.connections['Block n1'].main[0][0].node,'Block n0 check 0');
  assert.throws(()=>normalizeStudio(definition(['loop-items','edit-fields'],[[0,1,1,0]])),/back/);
});
test('native Schedule only emits a scoped event; downstream actions start from an authorized webhook execution',()=>{
  const v=compile(definition(['schedule','edit-fields'],[[0,0,1,0]]));
  assert.equal(v.mode,'schedule');
  assert.match(v.workflow.connections['Block n0'].main[0][0].node,/ trigger$/);
  assert.equal(v.workflow.connections['Block n0 event'].main[0][0].node,'Block n1 check 0');
  assert.equal(v.grant.result.allowObservation,false);
  assert.ok(v.workflow.nodes.some(n=>n.type==='n8n-nodes-base.webhook'));
});
test('catalog revisions and unavailable connections are rejected before compilation can execute them',()=>{
  const value=normalizeStudio(definition());validateStudioCapabilities(value,catalog);
  assert.throws(()=>validateStudioCapabilities(value,catalog.map(c=>({...c,sourceHash:'b'.repeat(64)}))),/revision/);
  assert.throws(()=>validateStudioCapabilities(value,catalog.map(c=>({...c,available:false}))),/revision/);
});
test('previously saved Studio sources retain their original validator, parameters and source hash', () => {
  const old = definition(['http-request'], []);
  old.nodes[0].params = { url: 'http://127.0.0.1:4631/spike/ka/demo-data', method: 'GET', body: { hello: 'DKG' } };
  const source = studioProgramSourceV1(compileStudioV1(old, { graphId, owner, fixture: true }));
  const read = readStudio(source);
  assert.equal(read.legacy, true);
  assert.deepEqual(read.definition.nodes[0].params, old.nodes[0].params);
  assert.equal(studioProgramSourceV1(read), source);
  const unchanged = definition(['limit'], []);
  assert.notEqual(compileStudio(unchanged, { graphId, owner, fixture: true }).kaRef, compileStudioV1(unchanged, { graphId, owner, fixture: true }).kaRef);
});

test('a lost native create acknowledgement is reconciled by name without a second create',async()=>{
  const f=environment();try{f.loseNextCreate();await assert.rejects(f.provider.provision(definition()),/lost-ack/);
    const saved=await f.provider.provision(definition());assert.equal(saved.grant.workflowId,'provider_1');
    assert.equal(f.calls.filter(([m,p])=>m==='POST'&&p==='/workflows').length,1);
    assert.equal(f.config.n8nNative.workflows.length,1);
  }finally{f.close();}
});
test('saving creates a Program KA with native permissions and no unused child authority; readback precedes success',async()=>{
  const f=environment();try{const w=await f.service.save(definition(),()=>{});assert.equal(w.approved,true);
    const source=f.sources.get(w.kaRef),approval=f.approvals.get(w.kaRef);
    assert.deepEqual(source.permittedPrograms,[]);
    assert.deepEqual(approval.typescript.children,[]);
    assert.deepEqual(approval.n8n,source.requestedPermissions.n8n);
    const request={kaRef:w.kaRef,sourceHash:w.sourceHash,itemsJson:'[{"name":"Ana"}]',invocationId:randomUUID()};
    const receipt=await f.service.run(request,()=>{});assert.equal(receipt.readbackVerified,true);assert.equal(receipt.steps.length,3);
    f.setCatalog(catalog.map(c=>({...c,available:false})));await assert.rejects(f.service.run({...request,invocationId:randomUUID()},()=>{}),/unavailable/);
    assert.equal(f.invocations.length,1);
  }finally{f.close();}
});
test('Google writes require authorization before provisioning or invoking',async()=>{
  const f=environment();try{await assert.rejects(f.service.save(definition(['edit-fields','google-sheets'],[[0,0,1,0]]),()=>{throw Error('key-required');}),/key-required/);
    assert.equal(f.calls.length,0);
  }finally{f.close();}
});
test('activation retries retain event identity and count; webhook receipt replay rejects changed inputs',async()=>{
  const f=environment();try{const w=await f.service.save(definition(['webhook','edit-fields'],[[0,0,1,0]]),()=>{});
    const activationId=randomUUID();await f.service.activate({kaRef:w.kaRef,sourceHash:w.sourceHash,active:true,activationId},()=>{});
    const h=await f.service.history(w.kaRef), key=h.eventPath.split('/').at(-1), invocationId=randomUUID(),value={invocationId,items:[{name:'Ana'}]};
    const first=await f.service.event(key,value);assert.deepEqual(await f.service.event(key,value),first);
    await assert.rejects(f.service.event(key,{...value,items:[{name:'Changed'}]}),/different input/);
    await f.service.activate({kaRef:w.kaRef,active:true,activationId},()=>{});
    const after=await f.service.history(w.kaRef);assert.equal(after.eventPath,h.eventPath);assert.equal(after.activation.count,1);assert.equal(f.invocations.length,1);
  }finally{f.close();}
});
test('a timer cannot invoke downstream actions after a component is revoked',async()=>{
  const f=environment();try {
    const w=await f.service.save(definition(['schedule','edit-fields'],[[0,0,1,0]]),()=>{});
    await assert.rejects(f.service.run({kaRef:w.kaRef,sourceHash:w.sourceHash,itemsJson:'[{}]',invocationId:randomUUID()},()=>{}),/Activate/);
    await f.service.activate({kaRef:w.kaRef,active:true,activationId:randomUUID()},()=>{});
    f.setCatalog(catalog.map(c=>({...c,available:false})));
    await f.service.poll();assert.equal(f.invocations.length,0);assert.equal([...f.native.values()][0].active,false);
    assert.equal((await f.service.history(w.kaRef)).activation.active,false);
  } finally { f.close(); }
});

for (const mode of ['webhook', 'schedule']) test(`pending fifth ${mode} retains recovery after quota and poll`, async () => {
  const f = environment();
  try {
    const w = await f.service.save(definition([mode, 'edit-fields'], [[0,0,1,0]]), () => {});
    await f.service.activate({kaRef:w.kaRef,sourceHash:w.sourceHash,active:true,activationId:randomUUID()},()=>{});
    const row = f.provider.row(w.kaRef), a = JSON.parse(row.activation_json);
    a.count = 5; f.provider.db.prepare('UPDATE workflows SET activation_json=? WHERE ka_ref=?').run(JSON.stringify(a), w.kaRef);
    const invocationId = randomUUID(), executionId = mode === 'webhook' ? invocationId : '5';
    f.provider.db.prepare('INSERT INTO events(provider_id,execution_id,ka_ref,invocation_id,input_json) VALUES(?,?,?,?,?)')
      .run(row.provider_id, executionId, w.kaRef, invocationId, '[{}]');
    if (mode === 'schedule') {
      const native = f.native.get(row.provider_id), workflowData = {...native.activeVersion, settings:native.settings};
      const trigger = workflowData.nodes.find(n => n.name.endsWith(' trigger')).name;
      for (const id of ['5','6']) f.executions.set(id, {id,workflowId:row.provider_id,status:'success',startedAt:new Date(a.startedAt+1).toISOString(),workflowData,
        data:{resultData:{runData:{[trigger]:[{data:{main:[[{json:{}}]]}}]}}}});
    }
    f.restart();
    await f.service.poll();
    assert.equal(f.provider.row(w.kaRef).event_key, row.event_key);
    assert.equal(JSON.parse(f.provider.row(w.kaRef).activation_json).active, true);
    if (mode === 'webhook') {
      await assert.rejects(f.service.event(row.event_key,{invocationId:randomUUID(),items:[{}]}),/limit/);
      await f.service.event(row.event_key,{invocationId,items:[{}]});
    }
    assert.equal(f.invocations.length,1); assert.equal(f.invocations[0].invocationId,invocationId);
    assert.ok(f.provider.db.prepare('SELECT receipt_json FROM events WHERE execution_id=?').get(executionId).receipt_json);
    assert.equal(f.provider.db.prepare('SELECT count(*) AS n FROM events').get().n,1);
    f.setCatalog(catalog.map(c=>({...c,available:false}))); await f.service.poll();
    assert.equal(f.provider.row(w.kaRef).event_key,null);
  } finally { f.close(); }
});

test('native-only approval contract creates a new revision without rewriting legacy sources', () => {
  const current = compile(definition(['edit-fields'], []));
  const legacy = { ...current }; delete legacy.compiler;
  const previousSource = studioProgramSource(legacy);
  const previous = readStudio(previousSource);
  assert.equal(studioProgramSource(previous), previousSource);
  assert.notEqual(previous.kaRef, current.kaRef);
  assert.equal(readStudio(studioProgramSource(current)).kaRef, current.kaRef);
  assert.equal(readStudio(studioProgramSource(current)).compiler, 4);
});
