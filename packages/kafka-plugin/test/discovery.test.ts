import { describe, it, expect } from 'vitest';
import {
  buildListQuery,
  buildCountQuery,
  buildSingleByUalQuery,
  buildPageContentQuery,
  bindingsToKa,
} from '../src/discovery.js';
const META_URI = 'did:dkg:context-graph:urn:cg:demo/_meta';
const DATA_URI = 'did:dkg:context-graph:urn:cg:demo';
const PRIVATE_URI = 'did:dkg:context-graph:urn:cg:demo/_private';
const SUBGRAPH_META_URI = 'did:dkg:context-graph:urn:cg:demo/streams/_meta';
const SUBGRAPH_DATA_URI = 'did:dkg:context-graph:urn:cg:demo/streams';
const SUBGRAPH_PRIVATE_URI = 'did:dkg:context-graph:urn:cg:demo/streams/_private';
const STATUS = 'http://dkg.io/ontology/status';
const SUBGRAPH_NAME = 'http://dkg.io/ontology/subGraphName';
const PRIVATE_DATA_ANCHOR = 'http://dkg.io/ontology/privateDataAnchor';

function expectPublishableRootMetaScope(q: string): void {
  expect(q).toContain(`?ual <${STATUS}> ?registrationStatus .`);
  expect(q).toContain('FILTER(?registrationStatus IN ("confirmed", "tentative"))');
  expect(q).toContain(`FILTER NOT EXISTS { ?ual <${SUBGRAPH_NAME}> ?_subGraphName . }`);
}

function expectPublishableSubgraphMetaScope(q: string): void {
  expect(q).toContain(`?ual <${STATUS}> ?registrationStatus .`);
  expect(q).toContain('FILTER(?registrationStatus IN ("confirmed", "tentative"))');
  expect(q).toContain(`?ual <${SUBGRAPH_NAME}> "streams" .`);
  expect(q).not.toContain('FILTER NOT EXISTS');
}

function expectLegacyAndV2GraphResolution(
  q: string,
  dataUri = DATA_URI,
  privateUri = PRIVATE_URI,
): void {
  expect(q).toContain('?ka <http://dkg.io/ontology/partOf>');
  expect(q).toContain('<http://dkg.io/ontology/rootEntity> ?root');
  expect(q).toContain(
    `(<${dataUri}> <${dataUri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://ontology.dkg.io/streams#KafkaStream>)`,
  );
  expect(q).toContain(
    `(<${dataUri}> <${privateUri}> <${PRIVATE_DATA_ANCHOR}> "true")`,
  );
  expect(q).toContain('<http://dkg.io/ontology/contentScopeVersion> "2"^^<http://www.w3.org/2001/XMLSchema#integer>');
  expect(q).toContain('<http://dkg.io/ontology/kaUal>');
  expect(q).toContain('<http://dkg.io/ontology/assertionGraph> ?assertionGraph');
  expect(q).toContain('<http://dkg.io/ontology/privateTripleCount> ?privateCount');
  expect(q).toContain('REPLACE(STR(?assertionGraph), "/_verifiable_memory/", "/_private/")');
  expect(q).toContain('GRAPH ?publicGraph { ?root ?markerP ?markerO . }');
  expect(q).toContain('GRAPH ?contentGraph { ?root a <https://ontology.dkg.io/streams#KafkaStream> . }');
}

describe('discovery — buildListQuery', () => {
  it('selects one bounded page of legacy or V2 stream targets without expanding payload triples', () => {
    const q = buildListQuery({ contextGraphId: 'urn:cg:demo', limit: 30, offset: 0 });
    expect(q).toMatch(/^SELECT DISTINCT \?ual \?root \?receivedAt \?contentGraph WHERE/);
    expect(q).toContain(`GRAPH <${META_URI}>`);
    expect(q).not.toContain('SELECT ?ual ?root ?receivedAt ?p ?o');
    expectLegacyAndV2GraphResolution(q);
    expect(q).toContain('ORDER BY DESC(?receivedAt) ?ual ?root ?contentGraph');
    expect(q).toContain('LIMIT 30 OFFSET 0');
  });
  it('substitutes custom limit and offset into the LIMIT/OFFSET line', () => {
    const q = buildListQuery({ contextGraphId: 'urn:cg:demo', limit: 1000, offset: 250 });
    expect(q).toContain('LIMIT 1000 OFFSET 250');
  });
  it('uses root meta and sub-graph data URIs when subGraphName is configured', () => {
    const q = buildListQuery({
      contextGraphId: 'urn:cg:demo',
      subGraphName: 'streams',
      limit: 30,
      offset: 0,
    });
    expect(q).toContain(`GRAPH <${META_URI}>`);
    expectLegacyAndV2GraphResolution(q, SUBGRAPH_DATA_URI, SUBGRAPH_PRIVATE_URI);
    expect(q).not.toContain(`GRAPH <${SUBGRAPH_META_URI}>`);
    expect(q).not.toContain(`<${PRIVATE_URI}>`);
  });
  it('lists private-default streams by joining public anchors to the private payload graph', () => {
    const q = buildListQuery({ contextGraphId: 'urn:cg:demo', limit: 30, offset: 0 });
    expectLegacyAndV2GraphResolution(q);
  });
  it('lists confirmed or tentative root-graph registrations when no subGraphName is configured', () => {
    const q = buildListQuery({ contextGraphId: 'urn:cg:demo', limit: 30, offset: 0 });
    expectPublishableRootMetaScope(q);
  });
  it('lists confirmed or tentative registrations for the configured subGraphName', () => {
    const q = buildListQuery({
      contextGraphId: 'urn:cg:demo',
      subGraphName: 'streams',
      limit: 30,
      offset: 0,
    });
    expectPublishableSubgraphMetaScope(q);
  });
  it('orders and paginates stream targets before the separate payload fetch', () => {
    const q = buildListQuery({ contextGraphId: 'urn:cg:demo', limit: 30, offset: 0 });
    expect(q).toMatch(/^SELECT DISTINCT \?ual \?root \?receivedAt \?contentGraph WHERE/);
    expect(q).toContain('ORDER BY DESC(?receivedAt) ?ual ?root ?contentGraph');
    expect(q.trimEnd()).toMatch(/LIMIT 30 OFFSET 0$/);
  });
  it('rejects an unsafe contextGraphId to block SPARQL injection', () => {
    expect(() =>
      buildListQuery({ contextGraphId: 'urn:cg:demo> } DROP ALL {', limit: 30, offset: 0 }),
    ).toThrow();
  });
  it('rejects contextGraphId characters that would change the graph IRI', () => {
    for (const contextGraphId of ['urn:cg:demo?query', 'urn:cg:demo#fragment']) {
      expect(() => buildListQuery({ contextGraphId, limit: 30, offset: 0 })).toThrow();
    }
  });
});
describe('discovery — buildCountQuery', () => {
  it('counts distinct legacy or V2 stream UALs through top-level scoped graph variables', () => {
    const q = buildCountQuery({ contextGraphId: 'urn:cg:demo' });
    expect(q).toMatch(/^SELECT \(COUNT\(DISTINCT \?ual\) AS \?count\) WHERE/);
    expect(q).toContain(`GRAPH <${META_URI}>`);
    expectLegacyAndV2GraphResolution(q);
  });
  it('rejects an unsafe contextGraphId to block SPARQL injection', () => {
    expect(() => buildCountQuery({ contextGraphId: 'urn:cg:demo> } DROP ALL {' })).toThrow();
  });
  it('uses the root meta graph when counting streams for a configured subGraphName', () => {
    const q = buildCountQuery({
      contextGraphId: 'urn:cg:demo',
      subGraphName: 'streams',
    });
    expect(q).toContain(`GRAPH <${META_URI}>`);
    expectLegacyAndV2GraphResolution(q, SUBGRAPH_DATA_URI, SUBGRAPH_PRIVATE_URI);
    expect(q).not.toContain(`GRAPH <${SUBGRAPH_META_URI}>`);
    expect(q).not.toContain(`<${PRIVATE_URI}>`);
  });
  it('counts private-default streams by joining public anchors to the private payload graph', () => {
    const q = buildCountQuery({ contextGraphId: 'urn:cg:demo' });
    expectLegacyAndV2GraphResolution(q);
  });
  it('counts confirmed or tentative root-graph registrations when no subGraphName is configured', () => {
    const q = buildCountQuery({ contextGraphId: 'urn:cg:demo' });
    expectPublishableRootMetaScope(q);
  });
  it('counts confirmed or tentative registrations for the configured subGraphName', () => {
    const q = buildCountQuery({
      contextGraphId: 'urn:cg:demo',
      subGraphName: 'streams',
    });
    expectPublishableSubgraphMetaScope(q);
  });
});
describe('discovery — buildSingleByUalQuery', () => {
  it('resolves an exact legacy or V2 UAL and fetches only its admitted content graph', () => {
    const q = buildSingleByUalQuery({ contextGraphId: 'urn:cg:demo', ual: 'did:dkg:1/0xabc' });
    expect(q).toMatch(/^SELECT DISTINCT \?root \?p \?o WHERE/);
    expect(q).toContain(`GRAPH <${META_URI}>`);
    expect(q).toContain('<did:dkg:1/0xabc>');
    expectLegacyAndV2GraphResolution(q);
    expect(q).toContain('GRAPH ?contentGraph { ?root ?p ?o . }');
  });
  // Regression (read-both DISTINCT): on a pre-trim / mixed-version store the
  // bare UAL carries the collapsed `dkg:rootEntity` aggregate row AND the
  // legacy `<ual>/<n>` token carries `dkg:partOf` + `dkg:rootEntity`, so BOTH
  // meta-block UNION arms bind the same ?root. Without SELECT DISTINCT every
  // `?root ?p ?o` data triple is returned twice and bindingsToKa collapses
  // scalar properties into duplicate arrays (e.g. schema:name: ["demo","demo"]).
  // buildListQuery already guards this via its inner SELECT DISTINCT.
  it('selects DISTINCT ?root ?p ?o so mixed-store double rootEntity bindings cannot duplicate data triples', () => {
    const q = buildSingleByUalQuery({ contextGraphId: 'urn:cg:demo', ual: 'did:dkg:1/0xabc' });
    expect(q).toMatch(/^SELECT DISTINCT \?root \?p \?o WHERE/);
  });
  it('selects DISTINCT for a configured subGraphName too', () => {
    const q = buildSingleByUalQuery({
      contextGraphId: 'urn:cg:demo',
      subGraphName: 'streams',
      ual: 'did:dkg:1/0xabc',
    });
    expect(q).toMatch(/^SELECT DISTINCT \?root \?p \?o WHERE/);
  });
  it('keeps scalar properties scalar after DISTINCT dedupes the mixed-store double bindings', () => {
    // The exact rows the single-UAL query yields on a mixed store. PRE-FIX (no
    // DISTINCT) the SPARQL engine emits each data triple TWICE — once per
    // matching meta-block UNION arm (legacy <ual>/0 partOf+rootEntity AND
    // collapsed <ual> rootEntity, both binding the same ?root). DISTINCT
    // collapses them back to one row each, so bindingsToKa returns scalars.
    const distinctRows = [
      { root: 'urn:entity:demo-root', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { root: 'urn:entity:demo-root', p: 'https://schema.org/name', o: '"demo"' },
      { root: 'urn:entity:demo-root', p: 'https://ontology.dkg.io/streams#kafkaBootstrapUrl', o: '"kafka://broker:9092"' },
    ];
    const ka = bindingsToKa(distinctRows.map((row) => ({ ...row, ual: 'did:dkg:1/0xabc' })));
    expect(ka!['schema:name']).toBe('demo');
    expect(ka!['dkg-streams:kafkaBootstrapUrl']).toBe('kafka://broker:9092');
    expect(ka!['@type']).toBe('dkg-streams:KafkaStream');

    // Guard the failure mode itself: had DISTINCT been absent, the engine would
    // have surfaced each row twice and the scalars would collapse into arrays.
    const duplicatedRows = [...distinctRows, ...distinctRows];
    const duplicatedKa = bindingsToKa(duplicatedRows.map((row) => ({ ...row, ual: 'did:dkg:1/0xabc' })));
    expect(duplicatedKa!['schema:name']).toEqual(['demo', 'demo']);
  });
  it('rejects UAL strings containing illegal SPARQL delimiters', () => {
    expect(() =>
      buildSingleByUalQuery({ contextGraphId: 'urn:cg:demo', ual: 'did:dkg:1/0x> } DROP {' }),
    ).toThrow();
  });
  it('rejects an unsafe contextGraphId to block SPARQL injection', () => {
    expect(() =>
      buildSingleByUalQuery({ contextGraphId: 'urn:cg:demo> } DROP ALL {', ual: 'did:dkg:1/0xabc' }),
    ).toThrow();
  });
  it('uses root meta and sub-graph data URIs when resolving a UAL for a configured subGraphName', () => {
    const q = buildSingleByUalQuery({
      contextGraphId: 'urn:cg:demo',
      subGraphName: 'streams',
      ual: 'did:dkg:1/0xabc',
    });
    expect(q).toContain(`GRAPH <${META_URI}>`);
    expectLegacyAndV2GraphResolution(q, SUBGRAPH_DATA_URI, SUBGRAPH_PRIVATE_URI);
    expect(q).not.toContain(`GRAPH <${SUBGRAPH_META_URI}>`);
    expect(q).not.toContain(`<${PRIVATE_URI}>`);
  });
  it('resolves private-default streams by joining public anchors to the private payload graph', () => {
    const q = buildSingleByUalQuery({ contextGraphId: 'urn:cg:demo', ual: 'did:dkg:1/0xabc' });
    expectLegacyAndV2GraphResolution(q);
  });
  it('resolves confirmed or tentative root-graph registrations when no subGraphName is configured', () => {
    const q = buildSingleByUalQuery({ contextGraphId: 'urn:cg:demo', ual: 'did:dkg:1/0xabc' });
    expect(q).toContain(`<did:dkg:1/0xabc> <${STATUS}> ?registrationStatus .`);
    expect(q).toContain('FILTER(?registrationStatus IN ("confirmed", "tentative"))');
    expect(q).toContain(
      `FILTER NOT EXISTS { <did:dkg:1/0xabc> <${SUBGRAPH_NAME}> ?_subGraphName . }`,
    );
  });
  it('resolves confirmed or tentative registrations for the configured subGraphName', () => {
    const q = buildSingleByUalQuery({
      contextGraphId: 'urn:cg:demo',
      subGraphName: 'streams',
      ual: 'did:dkg:1/0xabc',
    });
    expect(q).toContain(`<did:dkg:1/0xabc> <${STATUS}> ?registrationStatus .`);
    expect(q).toContain('FILTER(?registrationStatus IN ("confirmed", "tentative"))');
    expect(q).toContain(`<did:dkg:1/0xabc> <${SUBGRAPH_NAME}> "streams" .`);
    expect(q).not.toContain('FILTER NOT EXISTS');
  });
});
describe('discovery — buildPageContentQuery', () => {
  it('fetches payload triples for only the already-paginated exact graph targets', () => {
    const q = buildPageContentQuery([
      {
        ual: 'did:dkg:1/0xaaa',
        root: 'urn:entity:aaa',
        contentGraph: 'did:dkg:context-graph:urn:cg:demo/_private/0xaaa/1/assertions/1',
      },
      {
        ual: 'did:dkg:1/0xbbb',
        root: 'urn:entity:bbb',
        contentGraph: 'did:dkg:context-graph:urn:cg:demo/_verifiable_memory/0xbbb/2',
      },
    ]);
    expect(q).toMatch(/^SELECT DISTINCT \?ual \?root \?p \?o WHERE/);
    expect(q).toContain(
      '(<did:dkg:1/0xaaa> <urn:entity:aaa> <did:dkg:context-graph:urn:cg:demo/_private/0xaaa/1/assertions/1>)',
    );
    expect(q).toContain(
      '(<did:dkg:1/0xbbb> <urn:entity:bbb> <did:dkg:context-graph:urn:cg:demo/_verifiable_memory/0xbbb/2>)',
    );
    expect(q).toContain('GRAPH ?contentGraph { ?root ?p ?o . }');
    expect(q).not.toContain('OFFSET');
    expect(q).not.toContain('LIMIT');
  });

  it('deduplicates targets and rejects empty or unsafe target terms', () => {
    const target = {
      ual: 'did:dkg:1/0xaaa',
      root: 'urn:entity:aaa',
      contentGraph: 'did:dkg:context-graph:urn:cg:demo/_verifiable_memory/0xaaa/1',
    };
    const q = buildPageContentQuery([target, target]);
    expect(q.match(/\(<did:dkg:1\/0xaaa>/g)).toHaveLength(1);
    expect(() => buildPageContentQuery([])).toThrow(/at least one/i);
    expect(() => buildPageContentQuery([{ ...target, root: 'urn:bad> } DROP ALL {' }])).toThrow();
  });
});
describe('discovery — bindingsToKa decodes real N-Quads literal binding values', () => {
  // The Oxigraph adapter formats literal bindings as `"value"`, `"value"@lang`
  // or `"value"^^<datatype>`. IRIs are returned as the bare lexical form.
  it('strips quoting from plain string literals so JSON-LD scalars are not double-quoted', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://schema.org/name', o: '"demo"' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://ontology.dkg.io/streams#kafkaBootstrapUrl', o: '"kafka://broker:9092"' },
    ]);
    expect(ka).toEqual({
      '@context': {
        'dkg-streams': 'https://ontology.dkg.io/streams#',
        schema: 'https://schema.org/',
      },
      '@id': 'did:dkg:1/0xabc',
      '@type': 'dkg-streams:KafkaStream',
      'schema:name': 'demo',
      'dkg-streams:kafkaBootstrapUrl': 'kafka://broker:9092',
    });
  });
  it('decodes datatyped numeric literals to JS numbers', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://ontology.dkg.io/streams#somePort', o: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>' },
    ]);
    expect(ka!['dkg-streams:somePort']).toBe(42);
  });
  it('decodes extension XSD boolean and numeric literals to JS primitives', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://source.example/enabled', o: '"true"^^<http://www.w3.org/2001/XMLSchema#boolean>' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://source.example/threshold', o: '"0.75"^^<http://www.w3.org/2001/XMLSchema#decimal>' },
    ]);
    const prefix = Object.entries(ka!['@context']).find(([, iri]) => iri === 'https://source.example/')![0];
    expect(ka![`${prefix}:enabled`]).toBe(true);
    expect(ka![`${prefix}:threshold`]).toBe(0.75);
  });
  it('keeps unsafe XSD numeric values as strings to avoid precision loss', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://source.example/offset', o: '"9007199254740993"^^<http://www.w3.org/2001/XMLSchema#integer>' },
    ]);
    const prefix = Object.entries(ka!['@context']).find(([, iri]) => iri === 'https://source.example/')![0];
    expect(ka![`${prefix}:offset`]).toBe('9007199254740993');
  });
  it('decodes language-tagged literals to their lexical value (drops the lang tag)', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://schema.org/description', o: '"sample records"@en' },
    ]);
    expect(ka!['schema:description']).toBe('sample records');
  });
  it('unescapes N-Quads backslash sequences in string literals', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://schema.org/name', o: '"a\\"b\\nc"' },
    ]);
    expect(ka!['schema:name']).toBe('a"b\nc');
  });
  it('unescapes full N-Quads literal escapes including unicode and control characters', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://schema.org/name', o: '"caf\\u00E9 \\U0001F600\\b\\f"' },
    ]);
    expect(ka!['schema:name']).toBe('caf\u00e9 \u{1f600}\b\f');
  });
  it('uses ?ual (not ?root) as @id so the published UAL — not the RDF root subject — is returned to the caller', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:internal', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
    ]);
    expect(ka!['@id']).toBe('did:dkg:1/0xabc');
  });
  it('omits the internal private-data anchor marker from API JSON-LD', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: PRIVATE_DATA_ANCHOR, o: '"true"' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://schema.org/name', o: '"demo"' },
    ]);
    expect(ka!['schema:name']).toBe('demo');
    expect(ka).not.toHaveProperty('dkg:privateDataAnchor');
  });
});
describe('discovery — bindingsToKa basics', () => {
  it('builds a JSON-LD KA from triple-form bindings with bare-IRI object values', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://ontology.dkg.io/streams#protocol', o: '"kafka"' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://schema.org/name', o: '"demo-stream"' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://schema.org/description', o: '"sample records"' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://ontology.dkg.io/streams#kafkaBootstrapUrl', o: '"kafka://broker:9092"' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://ontology.dkg.io/streams#kafkaTopicName', o: '"demo-topic"' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://ontology.dkg.io/streams#dataFormat', o: '"JSON"' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
    ]);
    expect(ka).toEqual({
      '@context': {
        'dkg-streams': 'https://ontology.dkg.io/streams#',
        schema: 'https://schema.org/',
      },
      '@id': 'did:dkg:1/0xabc',
      '@type': 'dkg-streams:KafkaStream',
      'dkg-streams:protocol': 'kafka',
      'schema:name': 'demo-stream',
      'schema:description': 'sample records',
      'dkg-streams:kafkaBootstrapUrl': 'kafka://broker:9092',
      'dkg-streams:kafkaTopicName': 'demo-topic',
      'dkg-streams:dataFormat': 'JSON',
    });
  });
  it('returns null when bindings is empty', () => {
    expect(bindingsToKa([])).toBeNull();
  });
  it('accumulates repeated non-type predicates into arrays without changing scalar fields', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://schema.org/keywords', o: '"alpha"' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://schema.org/keywords', o: '"beta"' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://schema.org/name', o: '"demo"' },
    ]);
    expect(ka!['@type']).toBe('dkg-streams:KafkaStream');
    expect(ka!['schema:keywords']).toEqual(['alpha', 'beta']);
    expect(ka!['schema:name']).toBe('demo');
  });
  it('compacts unknown predicates via a synthesised @context prefix (Bug 2)', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://vendor.example/externalRef', o: '"ref-7"' },
    ]);
    expect(ka).not.toBeNull();
    const ctx = ka!['@context'] as Record<string, string>;
    const prefix = Object.entries(ctx).find(([, iri]) => iri === 'https://vendor.example/')?.[0];
    expect(prefix).toBeDefined();
    expect(ka![`${prefix}:externalRef`]).toBe('ref-7');
  });
});
// Bug 2: discovery must surface ALL stored rdf:type triples (not just the
// baseline), and reconstruct @context dynamically from the prefixes the
// bindings actually use — so write -> publish -> SPARQL -> read is a true
// round-trip for extensions adding secondary types and prefixes.
describe('discovery — Bug 2: bindingsToKa surfaces stored rdf:type triples', () => {
  it('emits scalar @type when only the baseline KafkaStream type is bound', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://schema.org/name', o: '"demo"' },
    ]);
    expect(ka!['@type']).toBe('dkg-streams:KafkaStream');
  });
  it('emits a multi-type array (baseline first, rest sorted) when extension types are bound', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://source.example/StreamingSource' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://vendor.example/TelemetryFeed' },
    ]);
    // Non-baseline types compact via synthesised prefixes; baseline stays
    // first, the rest sort lexicographically on their compacted form.
    const types = ka!['@type'] as string[];
    expect(Array.isArray(types)).toBe(true);
    expect(types[0]).toBe('dkg-streams:KafkaStream');
    expect(types).toHaveLength(3);
    const ctx = ka!['@context'] as Record<string, string>;
    const reverse = (compact: string): string => {
      const [prefix, local] = compact.split(':');
      return `${ctx[prefix]}${local}`;
    };
    const expanded = types.slice(1).map(reverse).sort();
    expect(expanded).toEqual([
      'https://source.example/StreamingSource',
      'https://vendor.example/TelemetryFeed',
    ]);
  });
  it('returns scalar baseline @type even if duplicate rdf:type rows bind the same baseline IRI', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
    ]);
    expect(ka!['@type']).toBe('dkg-streams:KafkaStream');
  });
});
describe('discovery — Bug 2: bindingsToKa reconstructs @context from observed prefixes', () => {
  it('omits unused baseline prefixes nothing — always keeps dkg-streams + schema', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
    ]);
    expect(ka!['@context']).toEqual({
      'dkg-streams': 'https://ontology.dkg.io/streams#',
      schema: 'https://schema.org/',
    });
  });
  it('adds a synthesised prefix when a non-baseline namespace appears in the bindings', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://vendor.example.com/ontology#externalRef', o: '"ref-alpha"' },
    ]);
    const ctx = ka!['@context'] as Record<string, string>;
    expect(ctx['dkg-streams']).toBe('https://ontology.dkg.io/streams#');
    expect(ctx.schema).toBe('https://schema.org/');
    const synthesised = Object.entries(ctx).find(
      ([, iri]) => iri === 'https://vendor.example.com/ontology#',
    );
    expect(synthesised).toBeDefined();
    const [prefix] = synthesised!;
    expect(ka![`${prefix}:externalRef`]).toBe('ref-alpha');
  });
  it('adds distinct prefixes for distinct non-baseline namespaces', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://vendor.example/externalRef', o: '"ref-alpha"' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://source.example/group', o: '"g1"' },
    ]);
    const ctx = ka!['@context'] as Record<string, string>;
    const vendorIris = Object.values(ctx).filter((iri) => iri === 'https://vendor.example/');
    const sourceIris = Object.values(ctx).filter((iri) => iri === 'https://source.example/');
    expect(vendorIris).toHaveLength(1);
    expect(sourceIris).toHaveLength(1);
  });
});
describe('discovery — Bug 2: synthesised prefix collisions + edge cases', () => {
  it('disambiguates two namespaces whose first hostname label is identical', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://vendor.example/externalRef', o: '"ref-alpha"' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'https://vendor.other.example/region', o: '"eu"' },
    ]);
    const ctx = ka!['@context'] as Record<string, string>;
    const prefixes = Object.entries(ctx)
      .filter(([p]) => p.startsWith('vendor'))
      .map(([p]) => p);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes.length).toBe(2);
  });
  it('strips angle-bracket wrapping on rdf:type object IRIs when the engine surfaces them', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: '<https://ontology.dkg.io/streams#KafkaStream>' },
    ]);
    expect(ka!['@type']).toBe('dkg-streams:KafkaStream');
  });
  it('falls back to "ns" prefix for an opaque namespace with no derivable stem', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'urn:opaque:weird/key', o: '"v"' },
    ]);
    const ctx = ka!['@context'] as Record<string, string>;
    const synthesised = Object.entries(ctx).find(([, iri]) => iri === 'urn:opaque:weird/');
    expect(synthesised).toBeDefined();
  });
  it('keeps non-IRI predicates verbatim if they cannot be split into namespace + local', () => {
    const ka = bindingsToKa([
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      { ual: 'did:dkg:1/0xabc', root: 'urn:entity:1', p: 'unsplittable', o: '"v"' },
    ]);
    expect(ka!['unsplittable']).toBe('v');
  });
});
describe('discovery — Bug 2: round-trip through ka-builder + bindingsToKa with extension secondary type', () => {
  it('preserves both baseline and extension @type entries across write and read', async () => {
    const { buildKa, mergeAugmentFragment } = await import('../src/ka-builder.js');
    const { coreSchema } = await import('../src/schema.js');
    const base = buildKa(coreSchema.parse({
      name: 'demo', kafkaBootstrapUrl: 'kafka://b:9092', kafkaTopicName: 'demo-topic',
    }));
    const ka = mergeAugmentFragment(
      base,
      { '@type': 'https://source.example/StreamingSource' },
      new Set<string>(),
    );
    const writtenTypes = Array.isArray(ka['@type']) ? ka['@type'] : [ka['@type']];
    // Simulate what publisher + Oxigraph would surface back as rdf:type bindings.
    const bindings = writtenTypes.map((t) => ({
      ual: 'did:dkg:1/0xabc',
      root: 'urn:entity:demo',
      p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      o: t.startsWith('dkg-streams:')
        ? `https://ontology.dkg.io/streams#${t.slice('dkg-streams:'.length)}`
        : t,
    }));
    const decoded = bindingsToKa(bindings);
    const types = decoded!['@type'] as string[];
    expect(Array.isArray(types)).toBe(true);
    expect(types[0]).toBe('dkg-streams:KafkaStream');
    expect(types).toHaveLength(2);
    const ctx = decoded!['@context'] as Record<string, string>;
    const [prefix, local] = types[1].split(':');
    expect(`${ctx[prefix]}${local}`).toBe('https://source.example/StreamingSource');
  });
});
