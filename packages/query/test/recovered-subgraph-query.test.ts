import { expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QueryHandler } from '../src/query-handler.js';

const id = 'recovered-routing', root = `did:dkg:context-graph:${id}`, meta = `${root}/_meta`;
const graph = `${root}/code/_verifiable_memory/0x0000000000000000000000000000000000000001/1`;
const asset = 'did:dkg:evm:31337/0x0000000000000000000000000000000000000001/1';
const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', entityType = 'urn:Code';
function descriptor(change?: string): Quad[] {
  const fields: Record<string, string> = {kaUal:asset,contentScopeVersion:'"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
    contextGraph:root,status:'"confirmed"',chainSnapshotDigest:'"local-authenticated-fixture"',assertionGraph:graph,subGraphName:'"code"'};
  if (change === 'tentative') fields.status = '"tentative"';
  if (change === 'other-graph') fields.contextGraph = root + '-other';
  if (change === 'other-asset') fields.kaUal = asset + '2';
  if (change === 'private') fields.assertionGraph = `${root}/code/_private/data`;
  if (change === 'missing-proof') delete fields.chainSnapshotDigest;
  return Object.entries(fields).map(([key,object]) => ({subject:asset,predicate:`http://dkg.io/ontology/${key}`,object,graph:meta}));
}
it.each([undefined,'tentative','other-graph','other-asset','private','missing-proof'])('routes only locally authenticated recovered partitions (%s)', async change => {
  const store = new OxigraphStore(), engine = new DKGQueryEngine(store);
  try {
    await store.insert([...descriptor(change),{subject:'urn:visible',predicate:type,object:entityType,graph},
      ...['code/_private/data','code/_meta','code/_rules/data','code/_verifiable_memory/staging/held'].map(tail =>
        ({subject:'urn:hidden',predicate:type,object:entityType,graph:`${root}/${tail}`}))]);
    const query = `SELECT ?entity WHERE {GRAPH ?g {?entity a <${entityType}>}}`;
    const expected = change ? [] : [{entity:'urn:visible'}];
    const scoped = await engine.query(query,{contextGraphId:id,includeContextGraphPartitions:true});
    expect(scoped.bindings).toEqual(expected);
    const vm = await engine.query(query,{contextGraphId:id,view:'verifiable-memory'});
    expect(vm.bindings).toEqual(expected);
    const handler = new QueryHandler(engine,{defaultPolicy:'public'});
    const entities = await handler.handle({operationId:'fixture',lookupType:'ENTITIES_BY_TYPE',contextGraphId:id,rdfType:entityType},'peer');
    expect(entities).toMatchObject({status:'OK',entityUris:change ? [] : ['urn:visible']});
  } finally { await store.close(); }
});
