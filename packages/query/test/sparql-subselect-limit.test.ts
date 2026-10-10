import {describe,it,expect} from 'vitest';
import {prepareSparql,prepareSparqlQuery} from '@origintrail-official/dkg-rdf-utils/sparql';
import {graphSubselectLimit} from '../src/sparql-subselect-limit.js';
import {OxigraphStore} from '@origintrail-official/dkg-storage';
import {DKGQueryEngine} from '../src/dkg-query-engine.js';
const limit=(query:string)=>{const p=prepareSparql(query);if(p.status!=='valid')throw new Error('invalid fixture');return graphSubselectLimit(prepareSparqlQuery(p));};
describe('safe inner graph-query LIMIT',()=>{
  it.each([
    ['SELECT ?s WHERE {?s ?p ?o} LIMIT 1',' LIMIT 1'],
    ['PREFIX x:<urn:> SELECT * {?s x:p ?o} LIMIT 20',' LIMIT 20'],
    ['select ?s ?o where {?s ?p ?o FILTER(?o="ORDER BY")} limit 0 # OFFSET 99',' LIMIT 0'],
    [String.raw`SELECT ?s W\u0048ERE {?s ?p ?o} L\u0049MIT 2`,' LIMIT 2'],
  ])('bounds only an unordered plain projection: %s',(q,expected)=>expect(limit(q)).toBe(expected));
  it.each([
    'SELECT DISTINCT ?s WHERE {?s ?p ?o} LIMIT 2',
    'SELECT REDUCED ?s WHERE {?s ?p ?o} LIMIT 2',
    'SELECT (COUNT(*) AS ?n) WHERE {?s ?p ?o} LIMIT 1',
    'SELECT (?o+1 AS ?n) WHERE {?s ?p ?o} LIMIT 1',
    'SELECT ?s WHERE {?s ?p ?o} ORDER BY ?s LIMIT 2',
    'SELECT ?s WHERE {?s ?p ?o} LIMIT 2 OFFSET 1',
    'SELECT ?s WHERE {?s ?p ?o} LIMIT 2 VALUES ?s {<urn:a>}',
    'SELECT ?s WHERE {?s ?p ?o} GROUP BY ?s HAVING(COUNT(*)>1) LIMIT 2',
    'SELECT ?s WHERE {?s ?p ?o}',
    'SELECT ?s FROM <urn:graph> WHERE {?s ?p ?o} LIMIT 1',
    'SELECT ?s WHERE {?s ?p ?o} LIMIT 9007199254740993',
    'CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o} LIMIT 1',
    'DESCRIBE ?s WHERE {?s ?p ?o} LIMIT 1',
    'ASK WHERE {?s ?p ?o}',
  ])('does not push a limit through result-changing modifiers: %s',q=>expect(limit(q)).toBe(''));
  it('retains bag multiplicity, mirrored-triple deduplication, distinct counts and ordering',async()=>{
    const store=new OxigraphStore();
    try {
      const root='did:dkg:context-graph:bounded-query';const vm=root+'/_verifiable_memory/0xAA/1';
      await store.insert([
        {subject:'urn:a',predicate:'urn:p',object:'"a"',graph:root},
        {subject:'urn:a',predicate:'urn:q',object:'"b"',graph:root},
        {subject:'urn:a',predicate:'urn:p',object:'"a"',graph:vm},
        {subject:'urn:z',predicate:'urn:p',object:'"c"',graph:vm},
      ]);
      const engine=new DKGQueryEngine(store);const opts={contextGraphId:'bounded-query'};
      const bag=await engine.query('SELECT ?s WHERE {?s ?p ?o FILTER(?s=<urn:a>)} LIMIT 2',opts);
      expect(bag.bindings).toEqual([{s:'urn:a'},{s:'urn:a'}]);
      expect((await engine.query('SELECT DISTINCT ?s WHERE {?s ?p ?o} LIMIT 2',opts)).bindings).toHaveLength(2);
      expect((await engine.query('SELECT (COUNT(*) AS ?n) WHERE {?s ?p ?o} LIMIT 1',opts)).bindings[0].n).toContain('3');
      expect((await engine.query('SELECT ?s WHERE {?s ?p ?o} ORDER BY DESC(?s) LIMIT 1',opts)).bindings).toEqual([{s:'urn:z'}]);
      expect((await engine.query('SELECT ?s WHERE {?s ?p ?o} ORDER BY ?s OFFSET 2 LIMIT 1',opts)).bindings).toEqual([{s:'urn:z'}]);
      const one=await engine.query('SELECT * WHERE {?s ?p ?o} LIMIT 1',opts);
      expect(one.bindings).toHaveLength(1);expect(Object.keys(one.bindings[0]).sort()).toEqual(['o','p','s']);
    }finally{await store.close();}
  });
});
