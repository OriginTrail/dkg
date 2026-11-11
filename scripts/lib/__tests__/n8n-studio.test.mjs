import { writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { createCapabilityBridge } from '../../../examples/n8n-capability/bridge.mjs';
import { createPreviewHandler } from '../../../examples/n8n-capability/cloudflare-preview.mjs';
import { normalizeN8nResult } from '../../../packages/cli/dist/semantic-runtime-n8n-contract.js';
import { collectN8nExecutionResult } from '../../../packages/cli/dist/semantic-runtime-n8n-results.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { component } from '../../../examples/n8n-capability/component-registry.mjs';
import { compileStudio, normalizeStudio, readStudio, studioProgramSource, validateStudioCapabilities } from '../../../examples/n8n-capability/studio-definition.mjs';
import { compileStudio as compileStudioV1, studioProgramSource as studioProgramSourceV1 } from '../../../examples/n8n-capability/studio-definition-v1.mjs';

import { graphId, owner, catalog, definition, environment } from '../../../examples/n8n-capability/test-support/studio-service-fixture.mjs';
const compile=v=>compileStudio(v,{graphId,owner,fixture:true,providerId:'unit_native'});

test('compiled loop keeps repeated terminal branches and the done output exactly once', () => {
  const compiled = compile(definition(['loop-items', 'if'], [[0,1,1,0], [1,0,0,0]]));
  const item = json => ({ json });
  const first = { accepted: 1 }, second = { accepted: 2 }, rejected1 = { rejected: 1 }, rejected2 = { rejected: 2 };
  const execution = { status: 'success', data: { resultData: { runData: {
    'Block n0': [
      { data: { main: [[], [item(first), item(rejected1)]] } },
      { data: { main: [[], [item(second), item(rejected2)]] } },
      { data: { main: [[item(first), item(second)], []] } },
    ],
    'Block n1': [
      { data: { main: [[item(first)], [item(rejected1)]] } },
      { data: { main: [[item(second)], [item(rejected2)]] } },
    ],
  } } } };
  const result = collectN8nExecutionResult(normalizeN8nResult(compiled.grant.result), execution);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.portsJson), { 'n0 done': [first, second], 'n1 false': [rejected1, rejected2] });
  assert.deepEqual(JSON.parse(result.traceJson).map(t => t.items), [[2,4], [2,2]]);
});

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
    f.restart();
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
test('fresh catalog policy fences save approval and persists export restrictions across reopen', async () => {
  const f = environment(), graph = definition(['webhook', 'edit-fields'], [[0,0,1,0]]);
  const deny = () => { throw new Error('export key required'); };
  const protectedCatalog = catalog.map(c => ({ ...c, requiresExportAuthorization: c.descriptor.id === 'edit-fields' }));
  try {
    // The first inspection is unprotected; the post-provision inspection is protected.
    f.beforeNextCatalog(() => f.beforeNextCatalog(() => f.setCatalog(protectedCatalog)));
    await assert.rejects(f.service.save(graph, deny), /export key required/);
    assert.equal(f.approvals.size, 0);
    assert.equal(f.repository.list().length, 0);
    const saved = await f.service.save(graph, () => {});
    assert.equal(saved.requiresExportAuthorization, true);
    f.setCatalog(catalog); f.restart();
    await assert.rejects(f.service.save(graph, deny), /export key required/);
    await assert.rejects(f.service.run({ kaRef: saved.kaRef, sourceHash: saved.sourceHash, itemsJson: '[{}]', invocationId: randomUUID() }, deny), /export key required/);
    await assert.rejects(f.service.activate({ kaRef: saved.kaRef, active: true, activationId: randomUUID() }, deny), /export key required/);
    assert.equal(f.invocations.length, 0);
    await f.service.activate({ kaRef: saved.kaRef, active: true, activationId: randomUUID() }, () => {});
    assert.equal((await f.service.history(saved.kaRef, needsExport => !needsExport)).eventPath, undefined);
    assert.ok((await f.service.history(saved.kaRef, needsExport => needsExport)).eventPath);
    writeFileSync(f.exportTokenFile, 'revoked-export');
    await assert.rejects(f.service.event(f.repository.lifecycle(saved.kaRef).eventKey, { invocationId: randomUUID(), items: [{}] }), /export authorization changed/);
    assert.equal(f.invocations.length, 0);
  } finally { f.close(); }
});
test('current capability policy gates run, activation and event disclosure without a persisted export flag', async () => {
  const f = environment();
  try {
    const saved = await f.service.save(definition(['webhook', 'edit-fields'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: saved.kaRef, active: true, activationId: randomUUID() }, () => {});
    assert.equal(saved.requiresExportAuthorization, false);
    f.setCatalog(catalog.map(c => ({ ...c, requiresExportAuthorization: c.descriptor.id === 'edit-fields' })));
    const deny = () => { throw new Error('export key required'); };
    await assert.rejects(f.service.run({ kaRef: saved.kaRef, sourceHash: saved.sourceHash, itemsJson: '[{}]', invocationId: randomUUID() }, deny), /export key required/);
    await assert.rejects(f.service.activate({ kaRef: saved.kaRef, active: true, activationId: randomUUID() }, deny), /export key required/);
    assert.equal((await f.service.history(saved.kaRef, needsExport => !needsExport)).eventPath, undefined);
    await assert.rejects(f.service.event(f.repository.lifecycle(saved.kaRef).eventKey, { invocationId: randomUUID(), items: [{}] }), /export authorization changed/);
    f.setCatalog(catalog.map(c => ({ ...c, available: false })));
    assert.equal((await f.service.history(saved.kaRef, () => assert.fail('unavailable selection cannot be disclosed'))).eventPath, undefined);
    assert.equal(f.invocations.length, 0);
  } finally { f.close(); }
});
test('activation retries retain event identity and count; webhook receipt replay rejects changed inputs',async()=>{
  const f=environment();try{const w=await f.service.save(definition(['webhook','edit-fields'],[[0,0,1,0]]),()=>{});
    const activationId=randomUUID();await f.service.activate({kaRef:w.kaRef,sourceHash:w.sourceHash,active:true,activationId},()=>{});
    const h=await f.service.history(w.kaRef,()=>true), key=h.eventPath.split('/').at(-1), invocationId=randomUUID(),value={invocationId,items:[{name:'Ana'}]};
    const first=await f.service.event(key,value);assert.deepEqual(await f.service.event(key,value),first);
    await assert.rejects(f.service.event(key,{...value,items:[{name:'Changed'}]}),/different input/);
    await f.service.activate({kaRef:w.kaRef,active:true,activationId},()=>{});
    const after=await f.service.history(w.kaRef,()=>true);assert.equal(after.eventPath,h.eventPath);assert.equal(after.activation.count,1);assert.equal(f.invocations.length,1);
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

function timerExecution(f, row, id, normalized = true) {
  const native = f.native.get(row.providerId), a = row.activation;
  const workflowData = structuredClone({ ...native.activeVersion, settings: native.settings });
  const trigger = workflowData.nodes.find(n => n.name.endsWith(' trigger')).name;
  if (normalized) for (const node of workflowData.nodes) {
    if (typeof node.parameters.jsonOutput === 'string' && node.parameters.jsonOutput.startsWith('='))
      node.parameters.jsonOutput = node.parameters.jsonOutput.slice(1);
    if (node.type === 'n8n-nodes-base.httpRequest') {
      delete node.parameters.specifyBody; delete node.parameters.jsonBody;
    }
  }
  return { id, workflowId: row.providerId, workflowVersionId: native.activeVersion.versionId,
    status: 'success', startedAt: new Date(a.startedAt + 1).toISOString(), workflowData,
    data: { resultData: { runData: { [trigger]: [{ data: { main: [[{ json: { tick: id } }]] } }] } } } };
}

for (const mode of ['webhook', 'schedule']) for (const stage of ['source', 'approval', 'catalog']) {
  test(`temporary ${stage} inspection failure preserves ${mode} activation and pending recovery`, async () => {
    const f = environment();
    try {
      const w = await f.service.save(definition([mode, 'edit-fields'], [[0,0,1,0]]), () => {});
      await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
      const row = f.repository.lifecycle(w.kaRef), invocationId = randomUUID(), items = [{ name: 'retry' }];
      f.repository.reserveEvent({ kaRef: w.kaRef, providerId: row.providerId,
        executionId: mode === 'schedule' ? '7' : invocationId, invocationId,
        ...(mode === 'webhook' ? { inputJson: JSON.stringify(items) } : {}) }, () => {});
      if (mode === 'schedule') f.executions.set('7', timerExecution(f, row, '7'));
      const before = f.repository.activation(w.kaRef), pending = f.repository.pendingEvents(w.kaRef);
      const timeout = Object.assign(new Error('temporary inspection timeout'), { code: 'ETIMEDOUT', status: 503 });
      if (stage === 'catalog') f.failNextCatalog(timeout);
      else {
        const method = stage === 'source' ? 'getSource' : 'getApproval', read = f.client.programs[method];
        f.client.programs[method] = async () => { f.client.programs[method] = read; throw timeout; };
      }
      const calls = f.calls.length;
      await f.service.poll();
      assert.deepEqual(f.repository.activation(w.kaRef), before);
      assert.equal(f.repository.lifecycle(w.kaRef).eventKey, row.eventKey);
      assert.deepEqual(f.repository.pendingEvents(w.kaRef), pending);
      assert.equal(f.native.get(row.providerId).active, true);
      assert.equal(f.calls.length, calls); assert.equal(f.invocations.length, 0);
      f.restart(); await f.service.poll();
      if (mode === 'webhook') await f.service.event(row.eventKey, { invocationId, items });
      assert.equal(f.invocations.length, 1); assert.equal(f.invocations[0].invocationId, invocationId);
      assert.equal(f.repository.pendingEvents(w.kaRef).length, 0);
      assert.equal(f.repository.activation(w.kaRef).count, 1);
    } finally { f.close(); }
  });
}

for (const mode of ['webhook', 'schedule']) for (const loss of ['expired', 'approval', 'export']) {
  test(`confirmed ${loss} loss deactivates ${mode} without dispatch`, async () => {
    const f = environment();
    try {
      const w = await f.service.save(definition([mode, loss === 'export' ? 'google-sheets' : 'edit-fields'], [[0,0,1,0]]), () => {});
      await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
      const row = f.repository.lifecycle(w.kaRef);
      if (loss === 'expired') f.repository.setActivation(w.kaRef,
        { ...f.repository.activation(w.kaRef), expiresAt: Date.now() - 1 }, row.eventKey);
      if (loss === 'approval') f.approvals.get(w.kaRef).binding.enabled = false;
      if (loss === 'export') writeFileSync(f.exportTokenFile, 'rotated-fictional-export-authorization');
      await f.service.poll();
      assert.equal(f.repository.activation(w.kaRef).active, false);
      assert.equal(f.repository.lifecycle(w.kaRef).eventKey, null);
      if (mode === 'schedule') assert.equal(f.native.get(row.providerId).active, false);
      assert.equal(f.invocations.length, 0);
    } finally { f.close(); }
  });
}

for (const failure of ['reject', 'lost-ack', 'changed-pin']) test(`schedule deactivation survives ${failure}, restart and cleanup retry without dispatch`, async () => {
  const f = environment();
  try {
    const w = await f.service.save(definition(['schedule', 'google-sheets'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const row = f.repository.lifecycle(w.kaRef), native = f.native.get(row.providerId), original = structuredClone(native.activeVersion);
    f.executions.set('7', timerExecution(f, row, '7'));
    f.repository.reserveEvent({ kaRef: w.kaRef, providerId: row.providerId, executionId: '7', invocationId: randomUUID() }, () => {});
    const pending = f.repository.pendingEvents(w.kaRef);
    if (failure === 'changed-pin') native.activeVersion.nodes[0].parameters.changed = true;
    else f.setUnpublishFailure(failure);
    const request = { kaRef: w.kaRef, active: false, activationId: randomUUID() };
    await assert.rejects(f.service.activate(request, () => {}));
    assert.equal(f.repository.activation(w.kaRef).active, false);
    assert.equal(f.repository.lifecycle(w.kaRef).eventKey, null);
    assert.equal(f.repository.lifecycle(w.kaRef).pendingUnpublication, request.activationId);
    assert.equal((await f.service.history(w.kaRef, () => true)).eventPath, undefined);
    await assert.rejects(f.service.event(row.eventKey, { invocationId: randomUUID(), items: [{}] }), /Inactive/);
    f.restart();
    if (failure !== 'lost-ack') {
      await f.service.poll();
      assert.equal(f.repository.lifecycle(w.kaRef).pendingUnpublication, request.activationId);
      await assert.rejects(f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {}));
      assert.equal(f.repository.activation(w.kaRef).active, false);
    }
    assert.equal(f.repository.activation(w.kaRef).active, false);
    await assert.rejects(f.service.run({ kaRef: w.kaRef, sourceHash: w.sourceHash, itemsJson: '[{}]', invocationId: randomUUID() }, () => {}), /Activate/);
    assert.equal(f.invocations.length, 0);
    f.setUnpublishFailure(null); native.activeVersion = original;
    // Explicit retry and background reconciliation must both work after reopen.
    if (failure === 'lost-ack') await f.service.activate(request, () => {});
    else await f.service.poll();
    assert.equal(f.repository.lifecycle(w.kaRef).pendingUnpublication, null);
    assert.equal(native.active, false);
    assert.equal(f.repository.activation(w.kaRef).active, false);
    assert.deepEqual(f.repository.pendingEvents(w.kaRef), pending);
    await f.service.poll(); assert.equal(f.invocations.length, 0);
  } finally { f.close(); }
});

for (const mode of ['webhook', 'schedule']) for (const loss of ['deactivation', 'expiry', 'replacement']) test('unprotected ' + mode + ' rechecks ' + loss + ' after catalog inspection', async t => {
  const f = environment(), entered = Promise.withResolvers(), resume = Promise.withResolvers();
  try {
    const w = await f.service.save(definition([mode, 'http-request'], [[0,0,1,0]]), () => assert.fail('unexpected export authorization'));
    assert.equal(w.requiresExportAuthorization, false);
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const row = f.repository.lifecycle(w.kaRef);
    if (mode === 'schedule') f.executions.set('7', timerExecution(f, row, '7'));
    // Intake inspects once, then execution inspects again after reservation.
    f.beforeNextCatalog(() => f.beforeNextCatalog(async () => { entered.resolve(); await resume.promise; }));
    const denied = mode === 'webhook'
      ? assert.rejects(f.service.event(row.eventKey, { invocationId: randomUUID(), items: [{}] }), /inactive|activation changed/)
      : f.service.poll();
    await entered.promise;
    if (loss === 'expiry') {
      const expiresAt = f.repository.activation(w.kaRef).expiresAt;
      t.mock.method(Date, 'now', () => expiresAt + 1);
    } else {
      await f.service.activate({ kaRef: w.kaRef, active: false, activationId: randomUUID() }, () => {});
      if (loss === 'replacement') await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    }
    resume.resolve(); await denied;
    assert.equal(f.invocations.length, 0);
    assert.equal(f.repository.pendingEvents(w.kaRef).length, 1);
    // Explicit owner runs are independent of delegated webhook authority.
    if (mode === 'webhook') {
      assert.equal((await f.service.run({ kaRef: w.kaRef, sourceHash: w.sourceHash, itemsJson: '[{}]', invocationId: randomUUID() }, () => {})).persisted, true);
      assert.equal(f.invocations.length, 1);
    }
  } finally { resume.resolve(); t.mock.restoreAll(); f.close(); }
});

for (const mode of ['webhook', 'schedule']) test(mode + ' reconciliation rechecks activation after an acknowledged dispatch', async () => {
  const f = environment(); let attempts = 0;
  try {
    const w = await f.service.save(definition([mode, 'edit-fields'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const row = f.repository.lifecycle(w.kaRef);
    if (mode === 'schedule') f.executions.set('7', timerExecution(f, row, '7'));
    f.client.programs.invoke = async () => {
      attempts++;
      await f.service.activate({ kaRef: w.kaRef, active: false, activationId: randomUUID() }, () => {});
      throw Object.assign(new Error('inspect the durable acknowledgement'), { code: 'INVOCATION_REQUIRES_RECONCILIATION' });
    };
    if (mode === 'webhook') await assert.rejects(f.service.event(row.eventKey, { invocationId: randomUUID(), items: [{}] }), /inactive|activation changed/);
    else await f.service.poll();
    assert.equal(attempts, 1);
    assert.equal(f.repository.pendingEvents(w.kaRef).length, 1);
  } finally { f.close(); }
});

for (const mode of ['webhook', 'schedule']) test(mode + ' reconciliation retains export policy discovered after event reservation', async () => {
  const f = environment(); let attempts = 0;
  const protectedCatalog = catalog.map(c => ({ ...c, requiresExportAuthorization: c.descriptor.id === 'edit-fields' }));
  try {
    const saved = await f.service.save(definition([mode, 'edit-fields'], [[0,0,1,0]]), () => {});
    assert.equal(saved.requiresExportAuthorization, false);
    f.setCatalog(protectedCatalog);
    await f.service.activate({ kaRef: saved.kaRef, active: true, activationId: randomUUID() }, () => {});
    const row = f.repository.lifecycle(saved.kaRef);
    if (mode === 'schedule') f.executions.set('7', timerExecution(f, row, '7'));
    f.setCatalog(catalog);
    f.beforeNextCatalog(() => f.beforeNextCatalog(() => f.setCatalog(protectedCatalog)));
    f.client.programs.invoke = async () => {
      attempts++;
      writeFileSync(f.exportTokenFile, 'revoked-during-dispatch');
      throw Object.assign(new Error('inspect the durable acknowledgement'), { code: 'INVOCATION_REQUIRES_RECONCILIATION' });
    };
    if (mode === 'webhook') await assert.rejects(f.service.event(row.eventKey, { invocationId: randomUUID(), items: [{}] }), /export authorization changed/);
    else await f.service.poll();
    assert.equal(attempts, 1);
    assert.equal(f.repository.pendingEvents(saved.kaRef).length, 1);
    assert.equal(f.repository.activation(saved.kaRef).count, 1);
  } finally { f.close(); }
});

for (const mode of ['webhook', 'schedule']) for (const renewal of [false, true]) test(mode + ' pending activation cannot undo later deactivation, renewal=' + renewal, async () => {
  const f = environment(), entered = Promise.withResolvers(), resume = Promise.withResolvers();
  try {
    const w = await f.service.save(definition([mode, 'edit-fields'], [[0,0,1,0]]), () => {});
    if (renewal) await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    f.beforeNextCatalog(async () => { entered.resolve(); await resume.promise; });
    const pending = f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const denied = assert.rejects(pending, /activation changed/);
    await entered.promise;
    const revocationId = randomUUID();
    await f.service.activate({ kaRef: w.kaRef, active: false, activationId: revocationId }, () => {});
    const revoked = f.repository.lifecycle(w.kaRef);
    const nativeActive = [...f.native.values()][0].active;
    resume.resolve(); await denied;
    assert.deepEqual(f.repository.lifecycle(w.kaRef), revoked);
    assert.deepEqual(f.repository.activation(w.kaRef), { active: false, activationId: revocationId });
    assert.equal(f.repository.lifecycle(w.kaRef).eventKey, null);
    assert.equal([...f.native.values()][0].active, nativeActive);
    f.restart();
    assert.deepEqual(f.repository.lifecycle(w.kaRef), revoked);
  } finally { resume.resolve(); f.close(); }
});

test('activation waiting on provider cleanup cannot overwrite a later revocation', async () => {
  const f = environment(), entered = Promise.withResolvers(), resume = Promise.withResolvers();
  try {
    const w = await f.service.save(definition(['schedule', 'edit-fields'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    f.setUnpublishFailure('reject');
    await assert.rejects(f.service.activate({ kaRef: w.kaRef, active: false, activationId: randomUUID() }, () => {}));
    f.setUnpublishFailure(null);
    const publish = f.provider.setPublished; let pause = true;
    f.provider.setPublished = async (...args) => {
      if (pause) { pause = false; entered.resolve(); await resume.promise; }
      return publish(...args);
    };
    const denied = assert.rejects(f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {}), /activation changed/);
    await entered.promise;
    const revocationId = randomUUID();
    const locallyRevoked = Promise.withResolvers(), deactivate = f.repository.deactivate;
    f.repository.deactivate = (...args) => { const changed = deactivate(...args); locallyRevoked.resolve(); return changed; };
    const revoking = f.service.activate({ kaRef: w.kaRef, active: false, activationId: revocationId }, () => {});
    await locallyRevoked.promise;
    assert.deepEqual(f.repository.activation(w.kaRef), { active: false, activationId: revocationId });
    assert.equal(f.repository.lifecycle(w.kaRef).eventKey, null);
    // Local revocation is immediate; provider cleanup waits for the earlier operation.
    resume.resolve(); await Promise.all([denied, revoking]);
    assert.deepEqual(f.repository.activation(w.kaRef), { active: false, activationId: revocationId });
    assert.equal(f.repository.lifecycle(w.kaRef).eventKey, null);
    assert.equal(f.repository.lifecycle(w.kaRef).pendingUnpublication, null);
    assert.equal([...f.native.values()][0].active, false);
  } finally { resume.resolve(); f.close(); }
});

test('schedule deactivation orders cleanup after an earlier pending publication', async () => {
  const f = environment(); let release;
  try {
    const w = await f.service.save(definition(['schedule', 'edit-fields'], [[0,0,1,0]]), () => {});
    let entered, revoked;
    const reached = new Promise(resolve => { entered = resolve; });
    const localRevoked = new Promise(resolve => { revoked = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const setPublished = f.provider.setPublished;
    f.provider.setPublished = async (ref, active) => { if (active) { entered(); await wait; } return setPublished(ref, active); };
    const deactivate = f.repository.deactivate;
    f.repository.deactivate = (...args) => { const changed = deactivate(...args); revoked(); return changed; };
    const activating = f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    await reached;
    const deactivating = f.service.activate({ kaRef: w.kaRef, active: false, activationId: randomUUID() }, () => {});
    await localRevoked;
    assert.equal(f.repository.activation(w.kaRef).active, false);
    release(); await Promise.all([activating, deactivating]);
    assert.equal(f.native.get(f.repository.lifecycle(w.kaRef).providerId).active, false);
    assert.equal(f.repository.lifecycle(w.kaRef).pendingUnpublication, null);
    assert.equal(f.repository.lifecycle(w.kaRef).eventKey, null);
    assert.equal(f.invocations.length, 0);
  } finally { release?.(); f.close(); }
});

test('schedule deactivation fences an invocation already awaiting catalog inspection', async () => {
  const f = environment(); let release;
  try {
    const w = await f.service.save(definition(['schedule', 'edit-fields'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    let entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    f.beforeNextCatalog(async () => { entered(); await wait; });
    const refused = assert.rejects(f.service.run({ kaRef: w.kaRef, sourceHash: w.sourceHash,
      itemsJson: '[{}]', invocationId: randomUUID() }, () => {}), /inactive/);
    await reached; f.setUnpublishFailure('reject');
    await assert.rejects(f.service.activate({ kaRef: w.kaRef, active: false, activationId: randomUUID() }, () => {}));
    release(); await refused;
    assert.equal(f.invocations.length, 0);
  } finally { release?.(); f.close(); }
});

for (const loss of ['expired', 'approval', 'export', 'component']) test(`confirmed ${loss} revocation persists despite failed schedule unpublication`, async () => {
  const f = environment();
  try {
    const w = await f.service.save(definition(['schedule', 'google-sheets'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const row = f.repository.lifecycle(w.kaRef), native = f.native.get(row.providerId);
    f.executions.set('7', timerExecution(f, row, '7')); f.setUnpublishFailure('reject');
    if (loss === 'expired') f.repository.setActivation(w.kaRef, { ...f.repository.activation(w.kaRef), expiresAt: Date.now() - 1 }, row.eventKey);
    if (loss === 'approval') f.approvals.get(w.kaRef).binding.enabled = false;
    if (loss === 'export') writeFileSync(f.exportTokenFile, 'revoked-export');
    if (loss === 'component') f.setCatalog(catalog.map(c => ({ ...c, available: false })));
    await f.service.poll();
    assert.equal(f.repository.activation(w.kaRef).active, false);
    assert.equal(f.repository.lifecycle(w.kaRef).eventKey, null);
    assert.ok(f.repository.lifecycle(w.kaRef).pendingUnpublication);
    f.restart(); f.setUnpublishFailure(null);
    f.approvals.get(w.kaRef).binding.enabled = true; f.setCatalog(catalog);
    writeFileSync(f.exportTokenFile, 'operator-unit-fixture-only');
    // Cleanup is independent of DKG/catalog inspection once authority is revoked.
    f.client.programs.getSource = async () => { throw new Error('source inspection unavailable'); };
    await f.service.poll();
    assert.equal(f.repository.lifecycle(w.kaRef).pendingUnpublication, null);
    assert.equal(native.active, false);
    assert.equal(f.repository.activation(w.kaRef).active, false);
    assert.equal(f.invocations.length, 0);
  } finally { f.close(); }
});

for (const interrupted of [false, true]) test(`normalized timer ${interrupted ? 'recovers after restart' : 'is delivered once'}`, async () => {
  const f = environment();
  try {
    const w = await f.service.save(definition(['schedule', 'http-request'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const row = f.repository.lifecycle(w.kaRef), execution = timerExecution(f, row, '7');
    f.executions.set('7', execution);
    const invoke = f.client.programs.invoke, attempts = [], cached = new Map();
    let loseReply = interrupted;
    f.client.programs.invoke = async value => {
      attempts.push(value.invocationId);
      if (!cached.has(value.invocationId)) cached.set(value.invocationId, await invoke(value));
      if (loseReply) { loseReply = false; throw new Error('response lost after downstream execution'); }
      return cached.get(value.invocationId);
    };
    await f.service.poll();
    assert.equal(f.invocations.length, 1, 'normalized native evidence must admit the timer');
    const first = f.repository.db.prepare('SELECT * FROM events WHERE execution_id=?').get('7');
    assert.equal(first.invocation_id, f.invocations[0].invocationId);
    assert.equal(!!first.receipt_json, !interrupted);
    f.restart();
    await f.service.poll(); await f.service.poll();
    assert.equal(f.invocations.length, 1, 'the simulated downstream runtime executes each invocation once');
    assert.deepEqual(attempts, Array(interrupted ? 2 : 1).fill(first.invocation_id));
    const completed = f.repository.db.prepare('SELECT * FROM events WHERE execution_id=?').get('7');
    assert.equal(completed.invocation_id, first.invocation_id); assert.ok(completed.receipt_json);
    assert.equal(f.repository.lifecycle(w.kaRef).activation.count, 1);
  } finally { f.close(); }
});

test('timer admission rejects changed versions, published digests, identities, structure and scope', async () => {
  const f = environment();
  try {
    const w = await f.service.save(definition(['schedule', 'http-request'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const row = f.repository.lifecycle(w.kaRef), native = f.native.get(row.providerId);
    const original = structuredClone(native.activeVersion);
    for (const change of [
      e => { e.workflowVersionId = 'foreign-version'; },
      e => { delete e.workflowVersionId; },
      e => { e.workflowId = 'foreign-workflow'; },
      e => { e.id = '999'; },
      e => { e.status = 'running'; },
      e => { e.startedAt = 'not-a-date'; },
      e => { e.workflowData.nodes[0].type = 'n8n-nodes-base.httpRequest'; },
      e => { e.workflowData.nodes[0].credentials = { httpHeaderAuth: { id: 'foreign' } }; },
      e => { e.workflowData.connections = {}; },
      e => { e.data.resultData.runData = { 'foreign trigger': [{ data: { main: [[{ json: {} }]] } }] }; },
      () => { native.activeVersion.nodes[0].parameters.changed = true; },
      () => { native.active = false; },
    ]) {
      native.activeVersion = structuredClone(original); native.active = true;
      const e = timerExecution(f, row, '7'); change(e); f.executions.set('7', e);
      await f.service.poll();
      assert.equal(f.invocations.length, 0);
      assert.equal(f.repository.db.prepare('SELECT count(*) AS n FROM events').get().n, 0);
    }
    native.activeVersion = original; native.active = true;
    f.executions.set('7', timerExecution(f, row, '7'));
    await f.service.poll(); assert.equal(f.invocations.length, 1);
  } finally { f.close(); }
});

test('timer intake fetches off-page pending details once and preserves candidate order', async () => {
  const f = environment();
  try {
    const w = await f.service.save(definition(['schedule', 'edit-fields'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const row = f.repository.lifecycle(w.kaRef), invocationId = randomUUID();
    f.repository.reserveEvent({ kaRef: w.kaRef, providerId: row.providerId, executionId: '7', invocationId }, () => {});
    for (const id of ['9', '8', '7']) f.executions.set(id, timerExecution(f, row, id));
    f.setExecutionPage(['9', '8']);
    f.restart(); await f.service.poll();
    assert.deepEqual(f.invocations.map(v => JSON.parse(v.inputs[0].itemsJson)[0].tick), ['7', '8', '9']);
    assert.equal(f.invocations[0].invocationId, invocationId);
    for (const id of ['7', '8', '9']) assert.equal(f.calls.filter(([method, path]) => method === 'GET' && path === '/executions/' + id).length, 1);
    assert.equal(f.repository.pendingEvents(w.kaRef).length, 0);
    assert.equal(f.repository.activation(w.kaRef).count, 3);
    await f.service.poll(); assert.equal(f.invocations.length, 3);
  } finally { f.close(); }
});

for (const mode of ['webhook', 'schedule']) test('failed quota persistence rolls back ' + mode + ' reservation before dispatch', async () => {
  const f = environment();
  try {
    const w = await f.service.save(definition([mode, 'edit-fields'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const row = f.repository.lifecycle(w.kaRef), value = { invocationId: randomUUID(), items: [{ value: 1 }] };
    if (mode === 'schedule') f.executions.set('7', timerExecution(f, row, '7'));
    f.repository.db.exec("CREATE TRIGGER fail_event_count BEFORE UPDATE OF activation_json ON workflows BEGIN SELECT RAISE(ABORT, 'count unavailable'); END");
    if (mode === 'webhook') await assert.rejects(f.service.event(row.eventKey, value), /count unavailable/);
    else await f.service.poll();
    assert.equal(f.invocations.length, 0);
    assert.equal(f.repository.db.prepare('SELECT count(*) AS n FROM events').get().n, 0);
    assert.equal(f.repository.lifecycle(w.kaRef).activation.count, 0);
    f.repository.db.exec('DROP TRIGGER fail_event_count');
    if (mode === 'webhook') {
      const receipt = await f.service.event(row.eventKey, value);
      assert.deepEqual(await f.service.event(row.eventKey, value), receipt);
    } else { await f.service.poll(); await f.service.poll(); }
    assert.equal(f.invocations.length, 1);
    assert.equal(f.repository.lifecycle(w.kaRef).activation.count, 1);
  } finally { f.close(); }
});

for (const mode of ['webhook', 'schedule']) test(`pending fifth ${mode} retains recovery after quota and poll`, async () => {
  const f = environment();
  try {
    const w = await f.service.save(definition([mode, 'edit-fields'], [[0,0,1,0]]), () => {});
    await f.service.activate({kaRef:w.kaRef,sourceHash:w.sourceHash,active:true,activationId:randomUUID()},()=>{});
    const row = f.repository.lifecycle(w.kaRef), a = row.activation;
    a.count = 5; f.repository.db.prepare('UPDATE workflows SET activation_json=? WHERE ka_ref=?').run(JSON.stringify(a), w.kaRef);
    const invocationId = randomUUID(), executionId = mode === 'webhook' ? invocationId : '5';
    f.repository.db.prepare('INSERT INTO events(provider_id,execution_id,ka_ref,invocation_id,input_json) VALUES(?,?,?,?,?)')
      .run(row.providerId, executionId, w.kaRef, invocationId, '[{}]');
    if (mode === 'schedule') {
      for (const id of ['5','6']) f.executions.set(id, timerExecution(f, row, id));
    }
    f.restart();
    await f.service.poll();
    assert.equal(f.repository.lifecycle(w.kaRef).eventKey, row.eventKey);
    assert.equal(f.repository.lifecycle(w.kaRef).activation.active, true);
    if (mode === 'webhook') {
      await assert.rejects(f.service.event(row.eventKey,{invocationId:randomUUID(),items:[{}]}),/limit/);
      await f.service.event(row.eventKey,{invocationId,items:[{}]});
    }
    assert.equal(f.invocations.length,1); assert.equal(f.invocations[0].invocationId,invocationId);
    assert.ok(f.repository.db.prepare('SELECT receipt_json FROM events WHERE execution_id=?').get(executionId).receipt_json);
    assert.equal(f.repository.db.prepare('SELECT count(*) AS n FROM events').get().n,1);
    f.setCatalog(catalog.map(c=>({...c,available:false}))); await f.service.poll();
    assert.equal(f.repository.lifecycle(w.kaRef).eventKey,null);
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

for (const protectedComponent of ['google-sheets', 'google-drive', 'edit-fields']) test(`history discloses ${protectedComponent} event capability only to authorized owners`, async () => {
  const f = environment(), secret = 'fictional-export-key-for-history-test';
  let bridge;
  try {
    writeFileSync(f.exportTokenFile, secret);
    const graph = protectedComponent === 'google-drive' ? definition(['webhook','convert-file','google-drive'], [[0,0,1,0],[1,0,2,0]])
      : definition(['webhook', protectedComponent], [[0,0,1,0]]);
    const w = await f.service.save(graph, () => {});
    await f.service.activate({kaRef:w.kaRef,active:true,activationId:randomUUID()},()=>{});
    f.client.programs.listApprovals = async () => [];
    for (const c of catalog) {
      f.sources.set(c.kaRef, { sourceHash: c.sourceHash, authorAgentAddress: owner, version: '1.0.0' });
      f.approvals.set(c.kaRef, { binding: { enabled: true, contextGraphId: graphId, operationIri: c.kaRef,
        executorAgentAddress: owner, allowedCallerAgentAddresses: [owner], n8n: {},
        program: { contextGraphId: graphId, programIri: c.kaRef, programLayer: 'wm', sourceHash: c.sourceHash, authorAgentAddress: owner } } });
    }
    bridge = createCapabilityBridge({ graphId, owner, config:f.config, client:f.client, definitions:catalog, exportTokenFile:f.exportTokenFile,
      agent:{query:async()=>({bindings:catalog.map(c=>({program:c.kaRef}))})}, studioOptions:{state:f.state,headerCredential:{id:'fixture-header',name:'Fixture'},credentials:{}} });
    writeFileSync(join(f.state, 'public-origin'), 'http://127.0.0.1:4621');
    const preview = createPreviewHandler(f.state, { send: async (url, options) => {
      const target = new URL(url), req = Readable.from([]);
      req.method = options.method; req.url = target.pathname + target.search; req.headers = options.headers;
      let status, body;
      await bridge.handle(req, { writeHead: s => { status = s; }, end: s => { body = s; } }, target.pathname);
      return new Response(body, { status, headers: { 'content-type': 'application/json' } });
    } });
    assert.equal((await f.service.history(w.kaRef)).eventPath, undefined);
    let delegatedPath;
    for (const throughPreview of [false, true]) for (const role of ['viewer','owner']) for (const token of [undefined,'wrong',secret]) {
      const req=Readable.from([]);req.method='GET';req.url='/spike/ka/accounts/account-a/capabilities/studio/history?kaRef='+encodeURIComponent(w.kaRef);
      req.headers={host:'127.0.0.1:4621',authorization:`Bearer l1-${role}-a`,...(token?{'x-dkg-export-token':token}:{})};
      let status,body;const res={writeHead:s=>{status=s;},end:s=>{body=JSON.parse(s);}};
      if (throughPreview) await preview(req, res); else await bridge.handle(req,res,req.url.split('?')[0]);
      assert.equal(status,200);
      assert.ok(Array.isArray(body.executions));
      const allowed=role==='owner'&&(protectedComponent==='edit-fields'||token===secret);
      assert.equal(typeof body.eventPath==='string',allowed);
      if(allowed)delegatedPath=body.eventPath;
      else assert.ok(!JSON.stringify(body).includes(f.repository.lifecycle(w.kaRef).eventKey));
    }
    // Possession of an explicitly disclosed URL remains a delegated invocation capability.
    const receipt=await f.service.event(delegatedPath.split('/').at(-1),{invocationId:randomUUID(),items:[{value:1}]});
    assert.equal(receipt.readbackVerified,true);assert.equal(f.invocations.length,1);
  } finally {bridge?.close();f.close();}
});


for (const mode of ['manual', 'webhook', 'schedule']) for (const revoked of ['caller', 'executor', 'enabled', 'missing']) {
  test(`current component ${revoked} revocation blocks saved ${mode} Studio dispatch`, async () => {
    const f = environment(); let bridge;
    try {
      const graph = mode === 'manual' ? definition(['edit-fields'], []) : definition([mode, 'edit-fields'], [[0,0,1,0]]);
      const definitions = graph.nodes.map(n => ({ kind: 'component', kaRef: n.kaRef, descriptor: component(n.componentId) }));
      const bindings = definitions.map(d => ({ contextGraphId: graphId, operationIri: d.kaRef, enabled: true,
        executorAgentAddress: owner, allowedCallerAgentAddresses: [owner], n8n: {},
        program: { contextGraphId: graphId, programIri: d.kaRef, programLayer: 'wm', sourceHash: 'a'.repeat(64), authorAgentAddress: owner } }));
      // Installation remains unchanged when the live approval is revoked.
      f.config.programBindings = structuredClone(bindings);
      for (const binding of bindings) {
        f.approvals.set(binding.operationIri, { binding });
        f.sources.set(binding.operationIri, { ...binding.program, version: '1.0.0' });
      }
      f.client.programs.listApprovals = async () => [];
      bridge = createCapabilityBridge({ graphId, owner, client: f.client, config: f.config, definitions,
        agent: { query: async () => ({ bindings: definitions.map(d => ({ program: d.kaRef })) }) },
        studioOptions: { state: f.state, headerCredential: { id: 'fixture-header', name: 'Fixture' }, credentials: {}, fetchImpl: f.fetchImpl } });
      const saved = await bridge.studio.save(graph, () => {});
      let eventKey;
      if (mode !== 'manual') {
        await bridge.studio.activate({ kaRef: saved.kaRef, active: true, activationId: randomUUID() }, () => {});
        eventKey = (await bridge.studio.history(saved.kaRef, () => true)).eventPath.split('/').at(-1);
      }
      const selected = bindings.at(-1);
      if (revoked === 'caller') selected.allowedCallerAgentAddresses = [];
      if (revoked === 'executor') selected.executorAgentAddress = '0x' + '2'.repeat(40);
      if (revoked === 'enabled') selected.enabled = false;
      if (revoked === 'missing') f.approvals.delete(selected.operationIri);
      const changed = e => e.code === 'WORKFLOW_CAPABILITY_CHANGED';
      await assert.rejects(bridge.studio.run({ kaRef: saved.kaRef, sourceHash: saved.sourceHash, itemsJson: '[{}]', invocationId: randomUUID() }, () => {}), changed);
      if (mode === 'webhook') await assert.rejects(bridge.studio.event(eventKey, { invocationId: randomUUID(), items: [{}] }), changed);
      if (mode !== 'manual') {
        await bridge.studio.poll();
        const history = await bridge.studio.history(saved.kaRef);
        assert.equal(history.activation.active, false);
        assert.equal(history.executions.length, 0);
      }
      assert.equal(f.invocations.length, 0);
      assert.equal(f.calls.some(([, path]) => path.startsWith('/executions')), false);
      assert.equal(f.config.programBindings.at(-1).enabled, true);
      assert.deepEqual(f.config.programBindings.at(-1).allowedCallerAgentAddresses, [owner]);
    } finally { bridge?.close(); f.close(); }
  });
}


test('reopening Studio restores only the native grant selected for an authorized run', async () => {
  const f = environment();
  try {
    const saved = await f.service.save(definition(), () => {});
    const grant = f.repository.nativeRevision(saved.kaRef).grant;
    f.config.n8nNative.workflows = [];
    f.restart();
    assert.deepEqual(f.config.n8nNative.workflows, []);
    assert.equal('db' in f.provider || 'repository' in f.provider || 'close' in f.provider, false);
    assert.equal((await f.service.list()).length, 1);
    assert.deepEqual(f.config.n8nNative.workflows, []);
    await f.service.run({ kaRef: saved.kaRef, sourceHash: saved.sourceHash, itemsJson: '[{}]', invocationId: randomUUID() }, () => {});
    assert.equal(f.config.n8nNative.workflows[0].workflowId, grant.workflowId);
    assert.equal(f.config.n8nNative.workflows[0].workflowSha256, grant.workflowSha256);
    f.config.n8nNative.workflows[0].workflowSha256 = 'f'.repeat(64);
    await assert.rejects(f.service.run({ kaRef: saved.kaRef, sourceHash: saved.sourceHash, itemsJson: '[{}]', invocationId: randomUUID() }, () => {}), /revision changed/);
    assert.equal(f.invocations.length, 1);
  } finally { f.close(); }
});
