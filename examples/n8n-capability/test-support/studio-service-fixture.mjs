import { dkgComponentStore } from '../dkg-components.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createStudioContext } from '../studio-context.mjs';
import { createStudioRepository } from '../studio-repository.mjs';
import { createStudioProvider } from '../studio-provider.mjs';
import { createStudioService } from '../studio-service.mjs';
import { fixtureProgramAuthority } from './studio-authority-fixture.mjs';
export const graphId='n8n-capability-poc', owner='0x'+'1'.repeat(40);
export function createStudioFixtureContext(profile = null) {
const context = createStudioContext({ profile });
const { compiler, registry: { componentRegistry, component } } = context;
const { readStudio } = compiler;
const catalog=componentRegistry.map(d=>({kind:'component',kaRef:'urn:demo:n8n:component:'+d.id+':unit',sourceHash:'a'.repeat(64),available:true,descriptor:d}));
function definition(ids=['edit-fields','if','limit'], edges=[[0,0,1,0],[1,0,2,0]]) {
  return {id:'00000000-0000-4000-8000-000000000001',name:'Unit native graph',entryId:'n0',
    nodes:ids.map((id,i)=>({id:'n'+i,componentId:id,kaRef:catalog.find(c=>c.descriptor.id===id).kaRef,sourceHash:'a'.repeat(64),params:Object.fromEntries(Object.entries(component(id).parameters).map(([k,s])=>[k,s.default])),x:i*240,y:100})),
    edges:edges.map(([a,output,b,input])=>({from:'n'+a,output,to:'n'+b,input}))};
}

function environment() {
  const state=mkdtempSync(join(tmpdir(),'studio-unit-')), token=join(state,'fixture-api'), exportTokenFile=join(state,'fixture-export');
  writeFileSync(token,'unit-test-fixture-only');writeFileSync(exportTokenFile,'operator-unit-fixture-only');
  const config={n8nNative:{baseUrl:'http://127.0.0.1:45678',apiTokenFile:token,webhookTokenFile:token,workflows:[]}};
  const native=new Map(),calls=[], executions=new Map();let loseCreate=false, executionPage=null, unpublishFailure=null, nativeReadFailure=null;
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname.replace('/api/v1',''),method=options.method;calls.push([method,path]);
    const body=options.body?JSON.parse(options.body):undefined;
    if(path==='/executions') return Response.json({data:[...executions.values()].filter(e=>!executionPage||executionPage.includes(e.id))});
    if(path.startsWith('/executions/')) return Response.json(executions.get(path.split('/')[2]));
    if(path==='/workflows'&&method==='GET') return Response.json({data:[...native.values()]});
    if(path.startsWith('/workflows/')&&method==='GET'&&nativeReadFailure){const error=nativeReadFailure;nativeReadFailure=null;throw error;}
    if(path==='/workflows'&&method==='POST'){const value={...body,id:'provider_'+(native.size+1),active:false,versionId:'version1'};native.set(value.id,value);if(loseCreate){loseCreate=false;throw Error('lost-ack');}return Response.json(value);}
    const [, , ,action]=path.split('/'); // /workflows/id[/publish]
    const key=path.split('/')[2],w=native.get(key);if(!w)return Response.json({},{status:404});
    if(method==='PUT'){Object.assign(w,body);return Response.json(w);}
    if(action==='publish'){w.active=true;w.activeVersion={...w};return Response.json(w);}
    if(action==='unpublish'){
      if(unpublishFailure==='reject') return Response.json({}, {status:503});
      w.active=false;delete w.activeVersion;
      if(unpublishFailure==='lost-ack') throw new Error('unpublish acknowledgement lost');
      return Response.json(w);
    }
    return Response.json(w);
  };
  let repository=createStudioRepository(state);
  const openProvider=()=>createStudioProvider({compiler,repository,config,graphId,owner,headerCredential:{id:'fixture-header',name:'Fixture'},credentials:{},fetchImpl});
  let provider=openProvider();
  const sources=new Map(), approvals=new Map(),outputs=new Map(),invocations=[]; let inventory=catalog, catalogFailure, catalogHook;
  const client={programs:{
    async getSource({programIri}){const s=sources.get(programIri);if(!s)throw Object.assign(Error('missing'),{code:'PROGRAM_NOT_FOUND',status:404});return s;},
    async upload(v){const source={...v,authorAgentAddress:owner,sourceHash:createHash('sha256').update(v.source).digest('hex')};sources.set(v.programIri,source);return source;},
    async getApproval({operationIri}){if(!approvals.has(operationIri))throw Object.assign(Error('missing'),{status:404});return approvals.get(operationIri);},
    async approve(v){approvals.set(v.operationIri,{...v,binding:{enabled:true,program:v.program}});},
    async invoke(v){invocations.push(v);const source=sources.get(v.operationIri),c=readStudio(source.source);
      const value={kind:'n8n-result',n8nExecutionId:'42',workflowSha256:c.grant.workflowSha256,output:{ok:true,itemsJson:v.inputs[0].itemsJson,portsJson:'{}',error:'',traceJson:JSON.stringify(c.grant.result.traceNodes.map(node=>({node,status:'completed',items:[1],outputHash:'a'.repeat(64)})))}};
      const executionIri='urn:sr:execution:'+v.invocationId,rawOutputs=[JSON.stringify(value)];outputs.set(executionIri,rawOutputs);return {...v,executionIri,rawOutputs,outputs:[value],persisted:true};},
  }};
  const openService=()=>createStudioService({compiler,graphId,owner,client,repository,provider,dkg:dkgComponentStore(repository.db,profile),programAuthority:fixtureProgramAuthority,exportTokenFile,listCapabilities:async()=>{if(catalogHook){const hook=catalogHook;catalogHook=undefined;await hook();}if(catalogFailure){const error=catalogFailure;catalogFailure=undefined;throw error;}return inventory;},loadOutputs:async iri=>outputs.get(iri)});
  let service=openService();
  return {context,compiler,profile,state,get repository(){return repository;},get provider(){return provider;},get service(){return service;},restart(){service.stop();repository.close();repository=createStudioRepository(state);provider=openProvider();service=openService();},client,native,calls,sources,approvals,invocations,config,exportTokenFile,executions,fetchImpl,setExecutionPage:ids=>{executionPage=ids;},setCatalog:v=>{inventory=v;},failNextCatalog:error=>{catalogFailure=error;},loseNextCreate:()=>{loseCreate=true;},
    setUnpublishFailure:value=>{unpublishFailure=value;},
    failNextNativeRead:error=>{nativeReadFailure=error;},
    beforeNextCatalog:hook=>{catalogHook=hook;},
    close(){service.stop();repository.close();rmSync(state,{recursive:true,force:true});}};
}

return { context, catalog, definition, environment };
}
export const { catalog, definition, environment } = createStudioFixtureContext();
