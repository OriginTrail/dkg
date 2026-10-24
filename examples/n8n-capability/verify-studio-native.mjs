/** Credential-free native graph fixture. --prepare writes CLI imports; default verifies real executions. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { component } from './component-registry.mjs';
import { compileStudio } from './studio-definition.mjs';
import { collectN8nExecutionResult } from '../../packages/cli/dist/semantic-runtime-n8n-results.js';

const state = resolve(process.argv[2] ?? ''); if (!process.argv[2]) throw new Error('Supply a credential-free fixture state.');
const manifest = JSON.parse(readFileSync(join(state, 'components.json'), 'utf8'));
if (manifest.components.some(c => c.descriptor.connection && c.enabled)) throw new Error('Never run this fixture against a Google-connected instance.');
const catalog = id => manifest.components.find(c => c.descriptor.id === id);
const defs = [
  { name: 'branch', ids: ['edit-fields','if','sort','limit'], edges: [[0,0,1,0],[1,0,2,0],[1,1,3,0]] },
  { name: 'files', ids: ['extract-file','rename-keys','convert-file'], edges: [[0,0,1,0],[1,0,2,0]] },
  { name: 'loop', ids: ['loop-items','edit-fields','aggregate'], edges: [[0,1,1,0],[1,0,0,0],[0,0,2,0]] },
  { name: 'schedule', ids: ['schedule','edit-fields'], edges: [[0,0,1,0]] },
];
const fixtures = defs.map((v, index) => {
  const definition = { id: `00000000-0000-4000-8000-00000000000${index}`, name: 'Native Studio fixture ' + v.name, entryId: 'step0',
    nodes: v.ids.map((id,i) => ({ id:'step'+i,componentId:id,kaRef:catalog(id).kaRef,sourceHash:'a'.repeat(64),
      params:Object.fromEntries(Object.entries(component(id).parameters).map(([k,s]) => [k,s.default])), x:i*250,y:100 })),
    edges:v.edges.map(([a,output,b,input]) => ({from:'step'+a,output,to:'step'+b,input})) };
  if (v.name === 'schedule') definition.nodes[0].params.minutes = 1;
  return { name:v.name, ...compileStudio(definition,{graphId:'n8n-capability-poc',owner:'0x'+'1'.repeat(40),fixture:true,providerId:'studio_fixture_'+v.name+'_v1'}) };
});
if (process.argv.includes('--prepare')) {
  const directory=join(state,'studio-fixtures'); mkdirSync(directory,{recursive:true,mode:0o700});
  for(const f of fixtures) writeFileSync(join(directory,f.workflowId+'.json'),JSON.stringify({...f.workflow,id:f.workflowId,versionId:randomUUID()}),{mode:0o600});
  console.log(JSON.stringify({prepared:fixtures.length,directory,ids:fixtures.map(f=>f.workflowId)}));
} else {
  const origin = new URL(process.argv[3] ?? 'http://127.0.0.1:45780');
  if(origin.origin!=='http://127.0.0.1:45780') throw new Error('Fixture loopback origin required.');
  const require=createRequire('/private/tmp/dkg-n8n-runtime-20261023/node_modules/n8n/package.json'),{parse}=require('flatted');
  const db=new DatabaseSync(join(state,'n8n/.n8n/database.sqlite'),{readOnly:true});
  const evidence=[];
  try {
    for(const f of fixtures) {
      const input={itemsJson:JSON.stringify(component(f.definition.nodes[0].componentId).sampleItems),paramsJson:JSON.stringify(f.definition.nodes[0].params),executionId:''};
      const res=await fetch(new URL('/webhook/dkg-capability-'+f.workflowId,origin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input}),signal:AbortSignal.timeout(15000)});
      assert.equal(res.status,200,f.name);const ack=await res.json();let execution;
      for(let attempt=0;attempt<150;attempt++) {
        const row=db.prepare('SELECT e.status,d.data FROM execution_entity e JOIN execution_data d ON d.executionId=e.id WHERE e.id=?').get(ack.executionId);
        if(row && !['new','running','waiting'].includes(row.status)){execution={status:row.status,data:parse(row.data)};break;}
        await delay(100);
      }
      assert.ok(execution,f.name+' unfinished');
      if(execution.status==='error') console.log(JSON.stringify({name:f.name,error:execution.data.resultData.error?.message,node:execution.data.resultData.lastNodeExecuted}));
      const output=collectN8nExecutionResult(f.grant,execution);assert.equal(output.ok,true,f.name);
      const items=JSON.parse(output.itemsJson),ports=JSON.parse(output.portsJson),trace=JSON.parse(output.traceJson);
      assert.equal(trace.length,f.definition.nodes.length);assert.ok(trace.every(s=>s.status==='completed'),f.name);
      if(f.name==='branch'){assert.equal(ports['step2 main'][0].name,'Ana');assert.equal(ports['step3 main'][0].name,'Luka');}
      if(f.name==='files') assert.ok(Buffer.from(items[0].file.base64,'base64').toString().includes('fullName'));
      if(f.name==='loop'){assert.equal(items[0].items.length,2);assert.ok(items[0].items.every(i=>i.team==='DKG'));}
      if(f.name==='schedule') assert.equal(items.length,2);
      evidence.push({graph:f.name,executionId:ack.executionId,nativeSteps:trace.length,verified:true});
      console.log(JSON.stringify(evidence.at(-1)));
    }
    writeFileSync(join(state,'native-studio-evidence.json'),JSON.stringify({fixtureOnly:true,evidence},null,2),{mode:0o600});
  } finally {db.close();}
}
