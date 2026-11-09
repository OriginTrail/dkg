import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProgramCatalog } from './program-catalog.mjs';
import { createStudioRepository } from './studio-repository.mjs';
import { createStudioService } from './studio-service.mjs';

function fixture(mode) {
  const graphId='graph-a',owner='0x'+'1'.repeat(40),sourceHash='a'.repeat(64), calls=[];
  const source={programIri:'urn:test:root-program',sourceHash,authorAgentAddress:owner,version:'1.0.0',language:'typescript-v1'};
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
    assert.equal(repository.row(saved.kaRef).requires_export,1);
  }finally{service.stop();repository.close();rmSync(state,{recursive:true,force:true});}
});
