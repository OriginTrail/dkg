import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { assertQuadLiteralsMutf8Safe, javaModifiedUtf8ByteLength } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { buildExecutionQuads, loadExecutionOutputs } from '../src/semantic-runtime.js';
import { buildExecutionOutputQuads, decodeExecutionOutputRows, EXECUTION_OUTPUT_CHUNK_BYTES, MAX_EXECUTION_OUTPUT_BYTES, type ExecutionOutputRow } from '../src/semantic-runtime-execution-output.js';

const SR = 'https://origintrail.io/semantic-runtime/v1#', execution = 'urn:sr:execution:test';
const owner = '0x1111111111111111111111111111111111111111', graph = 'test-output';
const memoryGraph = (layer = 'wm', address = owner, ka = 1, context = graph) =>
  `did:dkg:context-graph:${context}/${{wm:'_working_memory',swm:'_shared_memory',vm:'_verifiable_memory'}[layer]}/${address}/${ka}`;
const large = JSON.stringify({ bindings: Array.from({ length: 60 }, (_, id) => ({ id, payload: JSON.stringify({ memo: '\\'.repeat(100) }) })) });
const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function rows(outputs = [large]): ExecutionOutputRow[] {
  return buildExecutionOutputQuads(execution, outputs).map(q => ({g:memoryGraph(), [q.predicate.slice(SR.length)]:JSON.parse(q.object)}));
}
function replace(input: ExecutionOutputRow[], field: keyof ExecutionOutputRow, value: string) {
  return input.map(row => row[field] === undefined ? {...row} : {...row, [field]:value});
}
const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

describe('bounded execution output receipt codec', () => {
  it('keeps small legacy triples byte-for-byte and preserves output order and duplicates', () => {
    const outputs = ['b','a','b'];
    expect(buildExecutionOutputQuads(execution, outputs)).toEqual([
      ...outputs.flatMap(value => [{subject:execution,predicate:SR+'output',object:JSON.stringify(value)},
        {subject:execution,predicate:SR+'outputHash',object:JSON.stringify(hash(value))}]),
      {subject:execution,predicate:SR+'orderedOutputs',object:JSON.stringify(JSON.stringify(outputs))},
    ]);
    expect(decodeExecutionOutputRows(rows(outputs))).toEqual(outputs);
  });

  it('reproduces the extra escaping overflow and persists every native output literal below the existing guard', () => {
    expect(javaModifiedUtf8ByteLength(JSON.stringify(large))).toBeLessThan(60000);
    expect(javaModifiedUtf8ByteLength(JSON.stringify(JSON.stringify([large])))).toBeGreaterThan(60000);
    const quads = buildExecutionQuads({executionIri:execution,invocationId:'id',programIri:'urn:test:program',operatorIri:`did:dkg:agent:${owner}`,
      callerIri:`did:dkg:agent:${owner}`,policy:{iri:'urn:test:policy',version:'1',hash:'hash'},programHash:'hash',tools:[],events:[],
      outputs:[{role:'result',processId:new Uint8Array(),value:large}],agents:[],childExecutions:[],startedAt:new Date(0),finishedAt:new Date(1)});
    expect(() => assertQuadLiteralsMutf8Safe(quads)).not.toThrow();
    expect(quads.some(q=>q.predicate===SR+'orderedOutputsChunk')).toBe(true);
    expect(quads.some(q=>q.predicate===SR+'orderedOutputs' || q.predicate===SR+'output')).toBe(false);
    expect(decodeExecutionOutputRows(rows())).toEqual([large]);
  });

  it('round-trips larger individual outputs, Unicode, NUL, quoting and duplicate positions', () => {
    const value = '\u0000😀"\\\n'.repeat(12000);
    const outputs = [value,'tail',value];
    expect(() => assertQuadLiteralsMutf8Safe(buildExecutionOutputQuads(execution,outputs))).not.toThrow();
    expect(decodeExecutionOutputRows(rows(outputs).reverse())).toEqual(outputs);
  });

  it('bounds total receipt bytes without increasing the RDF literal guard', () => {
    expect(() => buildExecutionOutputQuads(execution,['a'.repeat(MAX_EXECUTION_OUTPUT_BYTES)])).toThrow('EXECUTION_OUTPUT_CAPACITY');
  });

  it.each(['missing-chunk','duplicate-chunk','index','base64','payload','hash','length','count','encoding','output-hash','mixed-graph','mixed-legacy','missing-manifest'])(
    'rejects %s without returning partial data', corruption => {
      let input = rows();
      const first = input.find(row=>row.orderedOutputsChunk!==undefined)!;
      const parsed = JSON.parse(first.orderedOutputsChunk!);
      if(corruption==='missing-chunk') input=input.filter(row=>row!==first);
      if(corruption==='duplicate-chunk') input.push({...first});
      if(corruption==='index') first.orderedOutputsChunk=JSON.stringify({...parsed,index:999});
      if(corruption==='base64') first.orderedOutputsChunk=JSON.stringify({...parsed,data:parsed.data+'='});
      if(corruption==='payload') first.orderedOutputsChunk=JSON.stringify({...parsed,data:(parsed.data[0]==='A'?'B':'A')+parsed.data.slice(1)});
      if(corruption==='hash') input=replace(input,'orderedOutputsSha256','sha256:'+'0'.repeat(64));
      if(corruption==='length') input=replace(input,'orderedOutputsByteLength','1');
      if(corruption==='count') input=replace(input,'orderedOutputsChunkCount','999999');
      if(corruption==='encoding') input.push({g:memoryGraph(),orderedOutputsEncoding:'other'});
      if(corruption==='output-hash') input=replace(input,'outputHash','sha256:'+'0'.repeat(64));
      if(corruption==='mixed-graph') first.g=memoryGraph('wm',owner,2);
      if(corruption==='mixed-legacy') input.push({g:memoryGraph(),output:large});
      if(corruption==='missing-manifest') input=input.filter(row=>row.orderedOutputsSha256===undefined);
      expect(()=>decodeExecutionOutputRows(input)).toThrow('EXECUTION_OUTPUT_ORDER_INVALID');
    });

  it('rejects malformed UTF8 even when the supplied byte hash matches', () => {
    const data=Buffer.from([255]);
    expect(()=>decodeExecutionOutputRows([
      {g:memoryGraph(),orderedOutputsEncoding:'utf8-base64-chunks-v1'},
      {g:memoryGraph(),orderedOutputsByteLength:'1'},
      {g:memoryGraph(),orderedOutputsChunkCount:'1'},
      {g:memoryGraph(),orderedOutputsSha256:hash(data)},
      {g:memoryGraph(),orderedOutputsChunk:JSON.stringify({index:0,data:data.toString('base64')})},
    ])).toThrow('EXECUTION_OUTPUT_ORDER_INVALID');
  });

  it('retains legacy single output compatibility and denies ambiguous unordered multi-output receipts', () => {
    expect(decodeExecutionOutputRows([{g:memoryGraph(),output:'old'}])).toEqual(['old']);
    expect(()=>decodeExecutionOutputRows([{g:memoryGraph(),output:'a'},{g:memoryGraph(),output:'b'}])).toThrow('EXECUTION_OUTPUT_ORDER_UNAVAILABLE');
    expect(()=>decodeExecutionOutputRows([{g:memoryGraph(),outputHash:hash('lost')}])).toThrow('EXECUTION_OUTPUT_ORDER_INVALID');
  });

  it('uses native SPARQL storage/readback and keeps graph, layer, author, execution and private lane scoped', async () => {
    const store=new OxigraphStore(); stores.push(store);
    await store.insert(buildExecutionOutputQuads(execution,[large]).map(q=>({...q,graph:memoryGraph()})));
    const queryOptions: unknown[]=[];
    const agent={query:async(sparql:string,options:unknown)=>{queryOptions.push(options);return store.query(sparql);}};
    expect(await loadExecutionOutputs(agent as any,graph,execution,'wm',owner)).toEqual([large]);
    expect(queryOptions[0]).toMatchObject({contextGraphId:graph,view:'working-memory',callerAgentAddress:owner,agentAddress:owner});
    await store.insert(buildExecutionOutputQuads(execution,['untrusted']).flatMap(q=>[
      {...q,graph:memoryGraph('wm','0x2222222222222222222222222222222222222222')},
      {...q,graph:memoryGraph('swm')}, {...q,graph:memoryGraph('wm',owner,3,'other')},
      {...q,subject:'urn:sr:execution:other',graph:memoryGraph('wm',owner,4)},
    ]));
    expect(await loadExecutionOutputs(agent as any,graph,execution,'wm',owner)).toEqual([large]);
  });

  it('native load rejects chunk fragments in another assertion even with the same executor', async () => {
    const store=new OxigraphStore(); stores.push(store);
    let changed=false;
    await store.insert(buildExecutionOutputQuads(execution,[large]).map(q=>{
      const other=!changed&&q.predicate===SR+'orderedOutputsChunk';if(other)changed=true;
      return {...q,graph:memoryGraph('wm',owner,other?2:1)};
    }));
    await expect(loadExecutionOutputs({query:(sparql:string)=>store.query(sparql)} as any,graph,execution,'wm',owner))
      .rejects.toMatchObject({code:'EXECUTION_OUTPUT_ORDER_INVALID'});
  });

  it('chunks use fixed bounded bytes before base64 and every resulting escaped literal stays below60k', () => {
    const input=rows();
    const chunks=input.filter(row=>row.orderedOutputsChunk!==undefined).map(row=>JSON.parse(row.orderedOutputsChunk!));
    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.from(chunks[0].data,'base64').length).toBe(EXECUTION_OUTPUT_CHUNK_BYTES);
    expect(()=>assertQuadLiteralsMutf8Safe(buildExecutionOutputQuads(execution,[large]))).not.toThrow();
  });
});
