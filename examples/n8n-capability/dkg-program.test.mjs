import { compiler, registry, profile } from './test-support/jpb-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { programRequest as requestProgram, programResult } from './dkg-program.mjs';
import { dkgComponentStore } from './test-support/dkg-component-store-fixture.mjs';
const { component } = registry;
const { compileStudio } = compiler;

const programRequest = (node, rows, id) => requestProgram(node, rows, id, profile);
const id = '11223344-1234-4234-8234-123456789abc';
const block = (id, componentId, params = {}) => ({ id, componentId,
  kaRef: 'urn:demo:n8n:component:' + componentId + ':1234', sourceHash: 'a'.repeat(64), x: 0, y: 0,
  params: { ...Object.fromEntries(Object.entries(component(componentId).parameters).map(([k,v]) => [k,v.default])), ...params } });
const node = block('invoke', 'invoke-dkg-program', { inputs: [{ rows: '{{ $json }}', quantity: '{{ $json[0].quantity }}' }] });
const rows = [{ quantity: null }, { quantity: 1320 }];
const receipt = r => ({ invocationId: r.invocationId, executionIri: 'urn:sr:execution:' + r.invocationId,
  operationIri: r.selected.operationIri, sourceHash: r.selected.program.sourceHash,
  bindingDigest: r.selected.bindingDigest, outputs: [{ total: 12 }] });

test('maps a whole joined batch with nulls intact, stable invocation identity and pinned Program', () => {
  const r = programRequest(node, rows, id);
  assert.deepEqual(r.inputs, [{ rows, quantity: null }]);
  assert.equal(r.invocationId, programRequest(node, rows, id).invocationId);
  assert.notEqual(r.invocationId, programRequest({ ...node, id: 'other' }, rows, id).invocationId);
  assert.equal(programResult(receipt(r), r).items[0].programExecution.sourceHash, r.selected.program.sourceHash);
  assert.equal(programResult(receipt(r), { ...r, outputMapping: '{{ $json[0].total }}' }).items[0].result, 12);
  assert.throws(() => programRequest({ ...node, params: { ...node.params, catalogRevision: 'old' } }, rows, id), /catalog changed/);
  assert.throws(() => programResult({ ...receipt(r), sourceHash: 'f'.repeat(64) }, r), /pinned/);
  assert.throws(() => programRequest({ ...node, params: { ...node.params, inputs: '{{ $json[0].missing }}' } }, rows, id), /not found/);
});
test('native n8n keeps branching and joining before a remote Program call', () => {
  const nodes = [block('start','edit-fields'),block('a','edit-fields'),block('b','edit-fields'),block('join','merge-fields'),node];
  const edges = [['start','a',0],['start','b',0],['a','join',0],['b','join',1],['join','invoke',0]]
    .map(([from,to,input])=>({from,to,input,output:0}));
  const c = compileStudio({ id, name: 'Map join invoke', entryId: 'start', nodes, edges }, { graphId:'g', owner:'a',headerCredential:{id:'reference',name:'local'} });
  assert.notEqual(c.executor, 'dkg');
  const n = c.workflow.nodes.find(n=>n.name==='Block invoke request');
  assert.equal(n.type,'n8n-nodes-base.httpRequest');
  assert.equal(n.executeOnce,true);
  assert.ok(c.grant.result.traceNodes.includes(n.name));
});
test('remote call requires an owner grant, journals before dispatch and caches confirmed retries', async () => {
  process.env.NOS_JPB_PROGRAM_ENABLED='1';
  const db = new DatabaseSync(':memory:');
  const workflow = { definition:{entryId:node.id,nodes:[node],edges:[]},kaRef:'urn:workflow:test',sourceHash:'b'.repeat(64) };
  let count=0, attempts=[];
  const store=dkgComponentStore(db,async (r,script)=>{
    assert.equal(script,'invoke'); attempts.push(r.invocationId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dkg_component_calls').get().n,1);
    if(++count===1) throw new Error('lost response');
    return receipt(r);
  },rows);
  const value={effectId:'urn:sr:effect:'+id+':0',workflowId:'native',executionId:'23',blockId:node.id,items:rows};
  await assert.rejects(store.call(value,workflow,'native'),/owner/);
  assert.throws(() => store.grant(workflow,id,{itemsJson:JSON.stringify(rows),paramsJson:'{}',executionId:''}), /reviewed workbook/);
  assert.equal(count, 0);
  store.grant(workflow,id,{itemsJson:JSON.stringify([{workbook: rows}]),paramsJson:'{}',executionId:''});
  await assert.rejects(store.call(value,workflow,'native'),/lost response/);
  const result=await store.call(value,workflow,'native');
  assert.deepEqual(await store.call(value,workflow,'native'),result);
  assert.equal(count,2);assert.equal(attempts[0],attempts[1]);
  await assert.rejects(store.call({...value,items:[{quantity:99}]},workflow,'native'),/different inputs/);
  db.close();
});
