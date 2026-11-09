import { Readable } from 'node:stream';
import { createCapabilityBridge } from '../../../examples/n8n-capability/bridge.mjs';
import { createPreviewHandler } from '../../../examples/n8n-capability/cloudflare-preview.mjs';
import { collectN8nExecutionResult } from '../../../packages/cli/dist/semantic-runtime-n8n-results.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { componentRegistry, component } from '../../../examples/n8n-capability/component-registry.mjs';
import { compileStudio, normalizeStudio, readStudio, studioProgramSource, validateStudioCapabilities } from '../../../examples/n8n-capability/studio-definition.mjs';
import { createStudioProvider } from '../../../examples/n8n-capability/studio-provider.mjs';
import { createStudioService } from '../../../examples/n8n-capability/studio-service.mjs';
import { compileStudio as compileStudioV1, studioProgramSource as studioProgramSourceV1 } from '../../../examples/n8n-capability/studio-definition-v1.mjs';

const graphId='n8n-capability-poc', owner='0x'+'1'.repeat(40);
const catalog=componentRegistry.map(d=>({kind:'component',kaRef:'urn:demo:n8n:component:'+d.id+':unit',sourceHash:'a'.repeat(64),available:true,descriptor:d}));
function definition(ids=['edit-fields','if','limit'], edges=[[0,0,1,0],[1,0,2,0]]) {
  return {id:'00000000-0000-4000-8000-000000000001',name:'Unit native graph',entryId:'n0',
    nodes:ids.map((id,i)=>({id:'n'+i,componentId:id,kaRef:catalog.find(c=>c.descriptor.id===id).kaRef,sourceHash:'a'.repeat(64),params:Object.fromEntries(Object.entries(component(id).parameters).map(([k,s])=>[k,s.default])),x:i*240,y:100})),
    edges:edges.map(([a,output,b,input])=>({from:'n'+a,output,to:'n'+b,input}))};
}
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
  const result = collectN8nExecutionResult(compiled.grant, execution);
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

function environment() {
  const state=mkdtempSync(join(tmpdir(),'studio-unit-')), token=join(state,'fixture-api'), exportTokenFile=join(state,'fixture-export');
  writeFileSync(token,'unit-test-fixture-only');writeFileSync(exportTokenFile,'operator-unit-fixture-only');
  const config={n8nNative:{baseUrl:'http://127.0.0.1:45678',apiTokenFile:token,webhookTokenFile:token,workflows:[]}};
  const native=new Map(),calls=[], executions=new Map();let loseCreate=false;
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname.replace('/api/v1',''),method=options.method;calls.push([method,path]);
    const body=options.body?JSON.parse(options.body):undefined;
    if(path==='/executions') return Response.json({data:[...executions.values()]});
    if(path.startsWith('/executions/')) return Response.json(executions.get(path.split('/')[2]));
    if(path==='/workflows'&&method==='GET') return Response.json({data:[...native.values()]});
    if(path==='/workflows'&&method==='POST'){const value={...body,id:'provider_'+(native.size+1),active:false,versionId:'version1'};native.set(value.id,value);if(loseCreate){loseCreate=false;throw Error('lost-ack');}return Response.json(value);}
    const [, , ,action]=path.split('/'); // /workflows/id[/publish]
    const key=path.split('/')[2],w=native.get(key);if(!w)return Response.json({},{status:404});
    if(method==='PUT'){Object.assign(w,body);return Response.json(w);}
    if(action==='publish'){w.active=true;w.activeVersion={...w};return Response.json(w);}
    if(action==='unpublish'){w.active=false;delete w.activeVersion;return Response.json(w);}
    return Response.json(w);
  };
  const openProvider=()=>createStudioProvider({state,config,graphId,owner,headerCredential:{id:'fixture-header',name:'Fixture'},credentials:{},fetchImpl});
  let provider=openProvider();
  const sources=new Map(), approvals=new Map(),outputs=new Map(),invocations=[]; let inventory=catalog;
  const client={programs:{
    async getSource({programIri}){const s=sources.get(programIri);if(!s)throw Object.assign(Error('missing'),{code:'PROGRAM_NOT_FOUND',status:404});return s;},
    async upload(v){const source={...v,authorAgentAddress:owner,sourceHash:createHash('sha256').update(v.source).digest('hex')};sources.set(v.programIri,source);return source;},
    async getApproval({operationIri}){if(!approvals.has(operationIri))throw Object.assign(Error('missing'),{status:404});return approvals.get(operationIri);},
    async approve(v){approvals.set(v.operationIri,{...v,binding:{enabled:true,program:v.program}});},
    async invoke(v){invocations.push(v);const source=sources.get(v.operationIri),c=readStudio(source.source);
      const value={kind:'n8n-result',n8nExecutionId:'42',workflowSha256:c.grant.workflowSha256,output:{ok:true,itemsJson:v.inputs[0].itemsJson,portsJson:'{}',error:'',traceJson:JSON.stringify(c.grant.result.traceNodes.map(node=>({node,status:'completed',items:[1],outputHash:'a'.repeat(64)})))}};
      const executionIri='urn:sr:execution:'+v.invocationId,rawOutputs=[JSON.stringify(value)];outputs.set(executionIri,rawOutputs);return {...v,executionIri,rawOutputs,outputs:[value],persisted:true};},
  }};
  const openService=()=>createStudioService({graphId,owner,client,provider,exportTokenFile,listCapabilities:async()=>inventory,loadOutputs:async iri=>outputs.get(iri)});
  let service=openService();
  return {state,get provider(){return provider;},get service(){return service;},restart(){service.stop();provider.close();provider=openProvider();service=openService();},client,native,calls,sources,approvals,invocations,config,exportTokenFile,executions,setCatalog:v=>{inventory=v;},loseNextCreate:()=>{loseCreate=true;},
    close(){service.stop();provider.close();rmSync(state,{recursive:true,force:true});}};
}
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
  const native = f.native.get(row.provider_id), a = JSON.parse(row.activation_json);
  const workflowData = structuredClone({ ...native.activeVersion, settings: native.settings });
  const trigger = workflowData.nodes.find(n => n.name.endsWith(' trigger')).name;
  if (normalized) for (const node of workflowData.nodes) {
    if (typeof node.parameters.jsonOutput === 'string' && node.parameters.jsonOutput.startsWith('='))
      node.parameters.jsonOutput = node.parameters.jsonOutput.slice(1);
    if (node.type === 'n8n-nodes-base.httpRequest') {
      delete node.parameters.specifyBody; delete node.parameters.jsonBody;
    }
  }
  return { id, workflowId: row.provider_id, workflowVersionId: native.activeVersion.versionId,
    status: 'success', startedAt: new Date(a.startedAt + 1).toISOString(), workflowData,
    data: { resultData: { runData: { [trigger]: [{ data: { main: [[{ json: { tick: id } }]] } }] } } } };
}

for (const interrupted of [false, true]) test(`normalized timer ${interrupted ? 'recovers after restart' : 'is delivered once'}`, async () => {
  const f = environment();
  try {
    const w = await f.service.save(definition(['schedule', 'http-request'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const row = f.provider.row(w.kaRef), execution = timerExecution(f, row, '7');
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
    const first = f.provider.db.prepare('SELECT * FROM events WHERE execution_id=?').get('7');
    assert.equal(first.invocation_id, f.invocations[0].invocationId);
    assert.equal(!!first.receipt_json, !interrupted);
    f.restart();
    await f.service.poll(); await f.service.poll();
    assert.equal(f.invocations.length, 1, 'the simulated downstream runtime executes each invocation once');
    assert.deepEqual(attempts, Array(interrupted ? 2 : 1).fill(first.invocation_id));
    const completed = f.provider.db.prepare('SELECT * FROM events WHERE execution_id=?').get('7');
    assert.equal(completed.invocation_id, first.invocation_id); assert.ok(completed.receipt_json);
    assert.equal(JSON.parse(f.provider.row(w.kaRef).activation_json).count, 1);
  } finally { f.close(); }
});

test('timer admission rejects changed versions, published digests, identities, structure and scope', async () => {
  const f = environment();
  try {
    const w = await f.service.save(definition(['schedule', 'http-request'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const row = f.provider.row(w.kaRef), native = f.native.get(row.provider_id);
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
      assert.equal(f.provider.db.prepare('SELECT count(*) AS n FROM events').get().n, 0);
    }
    native.activeVersion = original; native.active = true;
    f.executions.set('7', timerExecution(f, row, '7'));
    await f.service.poll(); assert.equal(f.invocations.length, 1);
  } finally { f.close(); }
});

test('failed quota persistence rolls back webhook reservation before dispatch', async () => {
  const f = environment();
  try {
    const w = await f.service.save(definition(['webhook', 'edit-fields'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const row = f.provider.row(w.kaRef), value = { invocationId: randomUUID(), items: [{ value: 1 }] };
    f.provider.db.exec("CREATE TRIGGER fail_event_count BEFORE UPDATE OF activation_json ON workflows BEGIN SELECT RAISE(ABORT, 'count unavailable'); END");
    await assert.rejects(f.service.event(row.event_key, value), /count unavailable/);
    assert.equal(f.invocations.length, 0);
    assert.equal(f.provider.db.prepare('SELECT count(*) AS n FROM events').get().n, 0);
    assert.equal(JSON.parse(f.provider.row(w.kaRef).activation_json).count, 0);
    f.provider.db.exec('DROP TRIGGER fail_event_count');
    const receipt = await f.service.event(row.event_key, value);
    assert.deepEqual(await f.service.event(row.event_key, value), receipt);
    assert.equal(f.invocations.length, 1);
    assert.equal(JSON.parse(f.provider.row(w.kaRef).activation_json).count, 1);
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
      for (const id of ['5','6']) f.executions.set(id, timerExecution(f, row, id));
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
    bridge = createCapabilityBridge({ graphId, owner, config:f.config, client:f.client, exportTokenFile:f.exportTokenFile,
      agent:{query:async()=>({bindings:[]})}, studioOptions:{state:f.state,headerCredential:{id:'fixture-header',name:'Fixture'},credentials:{}} });
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
      else assert.ok(!JSON.stringify(body).includes(f.provider.row(w.kaRef).event_key));
    }
    // Possession of an explicitly disclosed URL remains a delegated invocation capability.
    const receipt=await f.service.event(delegatedPath.split('/').at(-1),{invocationId:randomUUID(),items:[{value:1}]});
    assert.equal(receipt.readbackVerified,true);assert.equal(f.invocations.length,1);
  } finally {bridge?.close();f.close();}
});
