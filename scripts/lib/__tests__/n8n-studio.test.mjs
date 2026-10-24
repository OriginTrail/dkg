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
  const provider=createStudioProvider({state,config,graphId,owner,headerCredential:{id:'fixture-header',name:'Fixture'},credentials:{},fetchImpl});
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
  const service=createStudioService({graphId,owner,client,provider,exportTokenFile,listCapabilities:async()=>inventory,loadOutputs:async iri=>outputs.get(iri)});
  return {provider,service,native,calls,sources,approvals,invocations,config,exportTokenFile,executions,setCatalog:v=>{inventory=v;},loseNextCreate:()=>{loseCreate=true;},
    close(){service.stop();provider.close();rmSync(state,{recursive:true,force:true});}};
}
test('a lost native create acknowledgement is reconciled by name without a second create',async()=>{
  const f=environment();try{f.loseNextCreate();await assert.rejects(f.provider.provision(definition()),/lost-ack/);
    const saved=await f.provider.provision(definition());assert.equal(saved.grant.workflowId,'provider_1');
    assert.equal(f.calls.filter(([m,p])=>m==='POST'&&p==='/workflows').length,1);
    assert.equal(f.config.n8nNative.workflows.length,1);
  }finally{f.close();}
});
test('saving creates a Program KA with native permissions and pinned child authority; readback precedes success',async()=>{
  const f=environment();try{const w=await f.service.save(definition(),()=>{});assert.equal(w.approved,true);
    const source=f.sources.get(w.kaRef),approval=f.approvals.get(w.kaRef);
    assert.deepEqual(new Set(source.permittedPrograms),new Set(w.definition.nodes.map(n=>n.kaRef)));
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
