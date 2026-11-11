import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProgramCatalog } from './program-catalog.mjs';
import { createStudioRepository } from './studio-repository.mjs';
import { createStudioService } from './studio-service.mjs';
import { parseStudioCapability } from '../../packages/studio-contracts/dist/studio-evidence.js';
import { compileStudio, normalizeStudio, readStudio, studioProgramSource, validateStudioCapabilities } from './studio-definition.mjs';

function fixture(mode, programIri = 'urn:test:root-program') {
  const graphId='graph-a',owner='0x'+'1'.repeat(40),sourceHash='a'.repeat(64), calls=[];
  const source={programIri,sourceHash,authorAgentAddress:owner,version:'1.0.0',language:'typescript-v1'};
  const binding=(contextGraphId,operationIri,children=[])=>({contextGraphId,operationIri,enabled:true,executorAgentAddress:owner,
    allowedCallerAgentAddresses:[owner],program:{...source,contextGraphId,programLayer:'wm'},typescript:{children}});
  const root=binding(graphId,'urn:root',[{contextGraphId:'graph-b',operationIri:'urn:shared'}]);
  const collision=binding(graphId,'urn:shared');collision.program={...collision.program,programIri:'urn:demo:nos:studio:excluded'};
  const foreign=binding('graph-b','urn:shared',mode==='protected'?[{contextGraphId:'graph-c',operationIri:'urn:export'}]:[]);
  if(mode==='cycle')foreign.typescript.children=[{contextGraphId:graphId,operationIri:root.operationIri}];
  const leaf={...binding('graph-c','urn:export'),n8n:{workflowId:'google',workflowSha256:'b'.repeat(64)}};
  const client={programs:{
    listApprovals:async()=>[root,collision].map(binding=>({operationIri:binding.operationIri,binding})),
    getSource:async()=>source,
    getApproval:async pin=>{calls.push(pin);if(['missing','forbidden'].includes(mode))throw Object.assign(new Error(mode),{status:mode==='missing'?404:403});
      return {binding:mode==='wrong-graph'?collision:pin.graphId==='graph-b'?foreign:leaf};},
  }};
  const list=createProgramCatalog({graphId,owner,client,definitions:[{grant:leaf.n8n,requiresExportAuthorization:true}]});
  return {graphId,owner,client,list,calls,source,root};
}
function programDefinition(capability) {
  return { id: randomUUID(), name: 'Selected Program', entryId: 'program', nodes: [{ id: 'program', componentId: 'run-program',
    kaRef: capability.kaRef, sourceHash: capability.sourceHash, x: 0, y: 0,
    params: { operationIri: capability.operationIri, version: capability.version, inputMode: 'each-item', inputMapping: '{{ $json }}' } }], edges: [] };
}
for (const length of [230, 240]) test(`catalog offers a ${length}-character Program reference that Studio can save and read back`, async () => {
  const ref = 'urn:' + 'a'.repeat(length - 4), f = fixture('safe', ref);
  const capabilities = await f.list();
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0].kaRef, ref);
  assert.deepEqual(parseStudioCapability(capabilities[0]), capabilities[0]);
  const definition = normalizeStudio(programDefinition(capabilities[0]));
  validateStudioCapabilities(definition, capabilities);
  const compiled = compileStudio(definition);
  assert.deepEqual(readStudio(studioProgramSource(compiled)).definition, definition);
});
for (const [name, ref] of [
  ['241 characters', 'urn:' + 'a'.repeat(237)],
  ['oversized scheme', 'a'.repeat(239) + ':x'],
  ['whitespace', 'urn:invalid reference'],
  ['missing scheme', 'invalid-reference'],
  ['empty value', 'urn:'],
]) test(`catalog and Studio reject a Program reference with ${name}`, async () => {
  const f = fixture('safe', ref);
  assert.deepEqual(await f.list(), []);
  const definition = programDefinition({ kaRef: ref, sourceHash: f.source.sourceHash, operationIri: f.root.operationIri, version: f.source.version });
  assert.throws(() => normalizeStudio(definition), /pinned component KA/);
});
for(const mode of ['protected','safe','missing','forbidden','wrong-graph','cycle'])test(`catalog resolves child graph identity and fails closed (${mode})`,async()=>{
  const f=fixture(mode),entries=await f.list();
  assert.equal(entries.length,1);assert.equal(entries[0].requiresExportAuthorization,mode!=='safe');
  assert.deepEqual(f.calls[0],{graphId:'graph-b',operationIri:'urn:shared'});
  if(mode==='protected')assert.deepEqual(f.calls[1],{graphId:'graph-c',operationIri:'urn:export'});
});
test('cross-graph export protection gates actual Studio save and run before SDK dispatch',async()=>{
  const f=fixture('protected'),state=mkdtempSync(join(tmpdir(),'catalog-export-'));
  let uploads=0,invokes=0;const sources=new Map(),approvals=new Map();
  const sourceRead=f.client.programs.getSource,approvalRead=f.client.programs.getApproval;
  f.client.programs.getSource=async pin=>{
    if(sources.has(pin.programIri))return sources.get(pin.programIri);
    if(pin.programIri.startsWith('urn:demo:nos:studio:'))throw Object.assign(new Error('missing'),{code:'PROGRAM_NOT_FOUND'});
    return sourceRead(pin);
  };
  f.client.programs.getApproval=async pin=>{
    if(approvals.has(pin.operationIri))return approvals.get(pin.operationIri);
    if(pin.operationIri.startsWith('urn:demo:nos:studio:'))throw Object.assign(new Error('missing'),{status:404});
    return approvalRead(pin);
  };
  const {createHash}=await import('node:crypto');
  f.client.programs.upload=async value=>{uploads++;sources.set(value.programIri,{...value,authorAgentAddress:f.owner,sourceHash:createHash('sha256').update(value.source).digest('hex')});};
  f.client.programs.approve=async value=>approvals.set(value.operationIri,{binding:{enabled:true,program:value.program}});
  f.client.programs.invoke=async()=>{invokes++;throw new Error('fixture-dispatch');};
  const repository=createStudioRepository(state);
  const service=createStudioService({graphId:f.graphId,owner:f.owner,client:f.client,repository,listCapabilities:f.list,loadOutputs:async()=>[]});
  const definition={id:randomUUID(),name:'Cross graph export',entryId:'program',nodes:[{id:'program',componentId:'run-program',kaRef:f.source.programIri,sourceHash:f.source.sourceHash,
    params:{operationIri:f.root.operationIri,version:'1.0.0',inputMode:'each-item',inputMapping:'{{ $json }}'},x:0,y:0}],edges:[]};
  const deny=()=>{throw new Error('export key required');};
  try{
    await assert.rejects(service.save(definition,deny),/export key required/);assert.equal(uploads,0);
    const saved=await service.save(definition,()=>{});assert.equal(saved.requiresExportAuthorization,true);
    const request={kaRef:saved.kaRef,sourceHash:saved.sourceHash,itemsJson:'[{}]',invocationId:randomUUID()};
    await assert.rejects(service.run(request,deny),/export key required/);assert.equal(invokes,0);
    await assert.rejects(service.run(request,()=>{}),/fixture-dispatch/);assert.equal(invokes,1);
    // A later catalog inspection cannot erase an export requirement already saved.
    f.root.typescript.children=[];
    assert.equal((await f.list())[0].requiresExportAuthorization,false);
    await assert.rejects(service.save(definition,deny),/export key required/);
    await assert.rejects(service.run({...request,invocationId:randomUUID()},deny),/export key required/);
    assert.equal(uploads,1);assert.equal(invokes,1);
    assert.equal(repository.workflow(saved.kaRef).requiresExportAuthorization,true);
  }finally{service.stop();repository.close();rmSync(state,{recursive:true,force:true});}
});

function batchFixture(count) {
  const f = fixture('safe'), approvals = Array.from({ length: count }, (_, index) => ({
    ...f.root, operationIri: 'urn:operation:' + index,
    program: { ...f.root.program, programIri: 'urn:program:' + index }, typescript: { children: [] },
  }));
  f.client.programs.listApprovals = async () => approvals.map(binding => ({ operationIri: binding.operationIri, binding }));
  return { ...f, approvals };
}
test('catalog bounds metadata reads at four, filters pins and sorts independently of completion order', { timeout: 10000 }, async () => {
  const f = batchFixture(8), gates = Array.from({ length: 8 }, () => Promise.withResolvers());
  const first = Promise.withResolvers(), second = Promise.withResolvers(), calls = [];
  let active = 0, peak = 0;
  f.approvals.push({ ...f.approvals[0], enabled: false });
  f.approvals.push({ ...f.approvals[0], program: { ...f.approvals[0].program, programIri: 'urn:demo:nos:studio:excluded' } });
  f.client.programs.getSource = async ({ programIri }) => {
    const index = Number(programIri.split(':').at(-1));
    calls.push(index); active++; peak = Math.max(peak, active);
    if (calls.length === 4) first.resolve();
    if (calls.length === 8) second.resolve();
    await gates[index].promise; active--;
    return { ...f.source, programIri, label: 'Program ' + (8 - index),
      ...(index === 0 ? { sourceHash: 'stale' } : {}),
      ...(index === 1 ? { authorAgentAddress: 'different' } : {}),
      ...(index === 2 ? { language: 'sexpr-v1' } : {}),
      ...(index === 3 ? { version: '' } : {}),
    };
  };
  const listing = f.list();
  try {
    await first.promise;
    assert.deepEqual(calls, [0, 1, 2, 3]); assert.equal(active, 4);
    for (const index of [3, 2, 1, 0]) gates[index].resolve();
    await second.promise; assert.equal(active, 4);
    for (const index of [7, 6, 5, 4]) gates[index].resolve();
    const entries = await listing;
    assert.equal(peak, 4); assert.equal(active, 0);
    assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(entries.map(e => e.kaRef), [7, 6, 5, 4].map(i => 'urn:program:' + i));
    assert.ok(entries.every(e => !e.requiresExportAuthorization));
  } finally { for (const gate of gates) gate.resolve(); }
});
test('out-of-order metadata preserves approval-order export traversal and its shared budget', async () => {
  const f = batchFixture(2), gates = [Promise.withResolvers(), Promise.withResolvers()], started = Promise.withResolvers();
  let sources = 0; const inspected = [];
  for (const [index, binding] of f.approvals.entries()) binding.typescript.children = Array.from({ length: 80 }, (_, child) =>
    ({ contextGraphId: 'other-graph', operationIri: `urn:child:${index}:${child}` }));
  f.client.programs.getSource = async ({ programIri }) => {
    if (++sources === 2) started.resolve();
    await gates[Number(programIri.split(':').at(-1))].promise;
    return { ...f.source, programIri };
  };
  f.client.programs.getApproval = async pin => {
    inspected.push(pin.operationIri);
    return { binding: { enabled: true, contextGraphId: pin.graphId, operationIri: pin.operationIri } };
  };
  const listing = f.list();
  await started.promise;
  gates[1].resolve(); await Promise.resolve(); gates[0].resolve();
  const entries = await listing;
  assert.deepEqual(entries.map(e => e.requiresExportAuthorization), [false, true]);
  assert.deepEqual(inspected, [...Array.from({ length: 80 }, (_, i) => `urn:child:0:${i}`),
    ...Array.from({ length: 48 }, (_, i) => `urn:child:1:${i}`)]);
});
test('parallel Program metadata failures reject the catalog without returning a partial selector', async () => {
  const f = batchFixture(8), failure = new Error('metadata unavailable');
  f.client.programs.getSource = async ({ programIri }) => {
    if (programIri === 'urn:program:2') throw failure;
    return { ...f.source, programIri };
  };
  await assert.rejects(f.list(), error => error === failure);
});
