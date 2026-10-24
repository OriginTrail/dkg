import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { contextGraphDataUri, contextGraphMetaUri, contextGraphPrivateUri, contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, BlazegraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { buildEpcisQuery } from '../src/query-builder.js';
import { handleCaptureAsync, handleEventsQuery, toEpcisEvent } from '../src/handlers.js';

const CG = 'external-epcis-type';
const EPCIS = 'https://gs1.github.io/EPCIS/';
const EPCIS_CURRENT = 'https://ref.gs1.org/epcis/';
const DKG = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DATE_CASES = [
  { name: 'without dates', filters: {}, expected: ['early', 'event', 'late'] },
  { name: 'with a lower bound', filters: { from: '2024-03-01T00:00:00Z' }, expected: ['event', 'late'] },
  { name: 'with an upper bound', filters: { to: '2024-03-02T00:00:00Z' }, expected: ['early', 'event'] },
  { name: 'with both bounds', filters: { from: '2024-03-01T00:00:00Z', to: '2024-03-02T00:00:00Z' }, expected: ['event'] },
];

function eventRows(id: string, eventType: string, time?: string, offset?: string): Quad[] {
  const graph = contextGraphDataUri(CG);
  const subject = `urn:event:${id}`;
  return [
    { subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: eventType, graph },
    ...(time === undefined ? [] : [{ subject, predicate: `${EPCIS}eventTime`, object: `"${time}"`, graph }]),
    ...(offset === undefined ? [] : [{ subject, predicate: `${EPCIS}eventTimeZoneOffset`, object: `"${offset}"`, graph }]),
  ];
}

const blazegraphUrl = process.env.BLAZEGRAPH_TEST_URL;
if (process.env.DKG_REQUIRE_BLAZEGRAPH === '1' && !blazegraphUrl) throw new Error('BLAZEGRAPH_TEST_URL is required');
const backends: Array<{ name: string; create: () => OxigraphStore | BlazegraphStore }> = [
  { name: 'Oxigraph', create: () => new OxigraphStore() },
];
if (blazegraphUrl) backends.push({ name: 'Blazegraph', create: () => new BlazegraphStore(blazegraphUrl) });

describe.each(backends)('$name capture/query', ({ create }) => {
it('excludes the EPCISDocument container from an unfiltered event query', async () => {
  const store = create();
  const graph = contextGraphDataUri(CG);
  try {
    await store.insert([
      ...eventRows('event', `${EPCIS}ObjectEvent`, '2024-03-01T08:00:00Z', '+00:00'),
      ...eventRows('sensor', `${EPCIS}SensorElement`),
      { subject: 'urn:document', predicate: RDF_TYPE, object: `${EPCIS}EPCISDocument`, graph },
      { subject: 'urn:document', predicate: `${EPCIS}eventList`, object: 'urn:event:event', graph },
    ]);

    const result = await store.query(buildEpcisQuery({}, CG));
    if (result.type !== 'bindings') throw new Error('Expected event bindings');
    expect(result.bindings.map((row) => row.event)).toEqual(['urn:event:event']);
    expect(result.bindings.map((row) => row.eventType)).toEqual([`${EPCIS}ObjectEvent`]);
  } finally {
    await store.dropGraph(graph);
    await store.close();
  }
});

it.each(['public', 'private'] as const)('requires positive root evidence for unmarked standard events in %s data', async (visibility) => {
  const store = create();
  const publicGraph = contextGraphDataUri(CG);
  const graph = visibility === 'private' ? contextGraphPrivateUri(CG) : publicGraph;
  const metaGraph = contextGraphMetaUri(CG);
  const subjects = ['member', 'legacy-root', 'nested-standard', 'orphan-standard'];
  try {
    await store.insert([
      ...subjects.flatMap((id) => eventRows(id, `${EPCIS}ObjectEvent`, '2024-03-01T08:00:00Z', '+00:00')
        .map((quad) => ({ ...quad, graph }))),
      { subject: 'urn:document', predicate: `${EPCIS}eventList`, object: 'urn:event:member', graph },
      { subject: 'urn:event:member', predicate: 'https://example.org/detail', object: 'urn:event:nested-standard', graph },
      { subject: 'urn:publication:legacy', predicate: `${DKG}rootEntity`, object: 'urn:event:legacy-root', graph: metaGraph },
      ...(visibility === 'private' ? subjects.map((id) => ({
        subject: `urn:event:${id}`, predicate: `${DKG}privateDataAnchor`, object: '"true"', graph: publicGraph,
      })) : []),
    ]);

    const result = await store.query(buildEpcisQuery({}, CG));
    if (result.type !== 'bindings') throw new Error('Expected event bindings');
    expect(result.bindings.map((row) => row.event)).toEqual(['urn:event:legacy-root', 'urn:event:member']);
  } finally {
    await store.dropGraph(publicGraph);
    if (graph !== publicGraph) await store.dropGraph(graph);
    await store.dropGraph(metaGraph);
    await store.close();
  }
});

it.each(['public', 'private'] as const)('paginates unmarked multiply typed members once in %s data', async (visibility) => {
  const store = create();
  const publicGraph = contextGraphDataUri(CG);
  const graph = visibility === 'private' ? contextGraphPrivateUri(CG) : publicGraph;
  try {
    await store.insert([
      ...['member', 'second'].flatMap(id => eventRows(id, `${EPCIS}ObjectEvent`, '2024-03-01T08:00:00Z', '+00:00')
        .map(q => ({ ...q, graph }))),
      ...['https://example.org/TrackedEntity', `${EPCIS}SensorElement`, `${EPCIS}AuxiliaryEvent`].map(object =>
        ({ subject: 'urn:event:member', predicate: RDF_TYPE, object, graph })),
      ...['member', 'second'].map(id => ({ subject: 'urn:document', predicate: `${EPCIS}eventList`, object: `urn:event:${id}`, graph })),
      ...(visibility === 'private' ? ['member', 'second'].map(id => ({
        subject: `urn:event:${id}`, predicate: `${DKG}privateDataAnchor`, object: '"true"', graph: publicGraph,
      })) : []),
    ]);
    const pages = [];
    for (let offset = 0; offset < 3; offset++) {
      const result = await store.query(buildEpcisQuery({ limit: 1, offset }, CG));
      if (result.type !== 'bindings') throw new Error('Expected event bindings');
      pages.push(...result.bindings.map(row => ({ event: row.event, type: row.eventType })));
    }
    expect(pages).toEqual(['member', 'second'].map(id => ({ event: `urn:event:${id}`, type: `${EPCIS}ObjectEvent` })));
  } finally {
    await store.dropGraph(publicGraph);
    if (graph !== publicGraph) await store.dropGraph(graph);
    await store.close();
  }
});

it.each([EPCIS, EPCIS_CURRENT])('discovers published legacy GS1 extension roots in %s', async namespace => {
  const store = create();
  const graph = contextGraphDataUri(CG), metaGraph = contextGraphMetaUri(CG);
  const type = `${namespace}CustomEvent`;
  try {
    await store.insert([
      ...eventRows('custom', type, '2024-03-01T08:00:00Z', '+00:00')
        .map(q => ({ ...q, predicate: q.predicate.replace(EPCIS, namespace) })),
      { subject: 'urn:event:custom', predicate: RDF_TYPE, object: 'https://example.org/TrackedEntity', graph },
      ...['EPCISDocument', 'SensorElement'].map(name => ({ subject: `urn:${name}`, predicate: RDF_TYPE, object: `${namespace}${name}`, graph })),
      ...['urn:event:custom', 'urn:EPCISDocument', 'urn:SensorElement'].map((object, i) => ({
        subject: `urn:publication:${i}`, predicate: `${DKG}rootEntity`, object, graph: metaGraph,
      })),
    ]);
    for (const eventType of [undefined, type, ...(namespace === EPCIS ? ['CustomEvent'] : [])]) {
      const result = await store.query(buildEpcisQuery({ eventType }, CG));
      if (result.type !== 'bindings') throw new Error('Expected event bindings');
      expect(result.bindings.map(row => ({ event: row.event, type: row.eventType })))
        .toEqual([{ event: 'urn:event:custom', type }]);
    }
  } finally { await store.dropGraph(graph); await store.dropGraph(metaGraph); await store.close(); }
});

// This integration case makes 23 sequential HTTP queries on Blazegraph.
// Allow the complete matrix and cleanup to finish on shared CI runners.
it('projects and filters official-context EPCIS properties', async () => {
  const store = create();
  const contextGraphId = `${CG}-official-properties`;
  const graph = contextGraphDataUri(contextGraphId);
  const subject = 'urn:event:current-vocabulary';
  try {
    await store.insert([
      { subject, predicate: RDF_TYPE, object: `${EPCIS_CURRENT}ObjectEvent`, graph },
      { subject: 'urn:document', predicate: `${EPCIS_CURRENT}eventList`, object: subject, graph },
      { subject, predicate: `${EPCIS_CURRENT}eventTime`, object: '"2024-03-01T08:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTimeStamp>', graph },
      { subject, predicate: `${EPCIS_CURRENT}eventTimeZoneOffset`, object: '"+00:00"', graph },
      { subject, predicate: `${EPCIS_CURRENT}action`, object: '"ADD"', graph },
      { subject, predicate: `${EPCIS_CURRENT}epcList`, object: 'urn:epc:item', graph },
      { subject, predicate: `${EPCIS_CURRENT}parentID`, object: 'urn:epc:parent', graph },
      { subject, predicate: `${EPCIS_CURRENT}childEPCs`, object: 'urn:epc:child', graph },
      { subject, predicate: `${EPCIS_CURRENT}inputEPCList`, object: 'urn:epc:input', graph },
      { subject, predicate: `${EPCIS_CURRENT}outputEPCList`, object: 'urn:epc:output', graph },
      { subject, predicate: `${EPCIS_CURRENT}bizStep`, object: 'https://ref.gs1.org/cbv/BizStep-receiving', graph },
      { subject, predicate: `${EPCIS_CURRENT}disposition`, object: 'https://ref.gs1.org/cbv/Disp-in_progress', graph },
      { subject, predicate: `${EPCIS_CURRENT}readPoint`, object: 'urn:read:point', graph },
      { subject, predicate: `${EPCIS_CURRENT}bizLocation`, object: 'urn:business:location', graph },
    ]);
    const query = async (params = '') => handleEventsQuery(new URLSearchParams(params), {
      contextGraphId,
      basePath: '/api/epcis/events',
      queryEngine: { query: async (sparql: string) => {
        const result = await store.query(sparql);
        if (result.type !== 'bindings') throw new Error('Expected event bindings');
        return { bindings: result.bindings };
      } },
    });
    const events = (await query()).body.epcisBody.queryResults.resultsBody.eventList;
    expect(events).toEqual([expect.objectContaining({
      type: 'ObjectEvent', eventTime: '2024-03-01T08:00:00Z', eventTimeZoneOffset: '+00:00', action: 'ADD',
      epcList: ['urn:epc:item'], parentID: 'urn:epc:parent', childEPCs: ['urn:epc:child'],
      inputEPCList: ['urn:epc:input'], outputEPCList: ['urn:epc:output'],
      bizStep: 'https://ref.gs1.org/cbv/BizStep-receiving',
      disposition: 'https://ref.gs1.org/cbv/Disp-in_progress',
      readPoint: { id: 'urn:read:point' }, bizLocation: { id: 'urn:business:location' },
    })]);
    // A distinguishable event makes ignored filters observable.
    const other = 'urn:event:other-current-vocabulary';
    await store.insert([
      { subject: other, predicate: RDF_TYPE, object: `${EPCIS_CURRENT}AggregationEvent`, graph },
      { subject: 'urn:document', predicate: `${EPCIS_CURRENT}eventList`, object: other, graph },
      ...Object.entries({ eventTime: '"2020-03-01T08:00:00Z"', eventTimeZoneOffset: '"+00:00"',
        action: '"OBSERVE"', epcList: 'urn:other:epc', parentID: 'urn:other:parent', childEPCs: 'urn:other:child',
        inputEPCList: 'urn:other:input', outputEPCList: 'urn:other:output',
        bizStep: 'https://ref.gs1.org/cbv/BizStep-shipping', disposition: 'https://ref.gs1.org/cbv/Disp-active',
        readPoint: 'urn:other:read', bizLocation: 'urn:other:location',
      }).map(([field, object]) => ({ subject: other, predicate: `${EPCIS_CURRENT}${field}`, object, graph })),
    ]);
    expect((await query()).body.epcisBody.queryResults.resultsBody.eventList).toHaveLength(2);
    for (const params of [
      'eventType=ObjectEvent', 'eventType=https://ref.gs1.org/epcis/ObjectEvent', 'MATCH_epc=urn:epc:item',
      'MATCH_anyEPC=urn:epc:child', 'GE_eventTime=2024-03-01T00:00:00Z', 'EQ_action=ADD',
      'EQ_bizStep=receiving', 'EQ_disposition=in_progress', 'MATCH_parentID=urn:epc:parent',
      'childEPC=urn:epc:child', 'MATCH_inputEPC=urn:epc:input', 'MATCH_outputEPC=urn:epc:output',
      'EQ_readPoint=urn:read:point', 'EQ_bizLocation=urn:business:location',
    ]) expect((await query(params)).body.epcisBody.queryResults.resultsBody.eventList).toEqual(events);
    for (const params of ['EQ_action=DELETE', 'MATCH_epc=urn:epc:absent', 'MATCH_anyEPC=urn:epc:absent',
      'MATCH_parentID=urn:absent', 'childEPC=urn:absent', 'MATCH_inputEPC=urn:absent', 'MATCH_outputEPC=urn:absent']) {
      expect((await query(params)).body.epcisBody.queryResults.resultsBody.eventList).toEqual([]);
    }

  } finally {
    await store.dropGraph(graph);
    await store.close();
  }
}, 30_000);

it.each(['public', 'private'].flatMap(visibility =>
  ['ObjectEvent', 'TransformationEvent'].map(type => ({ visibility, type })),
))('paginates equivalent $type namespace aliases once in $visibility data', async ({ visibility, type }) => {
  const store = create();
  const contextGraphId = `${CG}-type-aliases`;
  const publicGraph = contextGraphDataUri(contextGraphId);
  const graph = visibility === 'private' ? contextGraphPrivateUri(contextGraphId) : publicGraph;
  const ids = ['urn:alias:a-unmarked', 'urn:alias:b-declared-legacy', 'urn:alias:c-declared-current'];
  try {
    await store.insert([
      ...ids.flatMap(subject => [
        { subject, predicate: RDF_TYPE, object: `${EPCIS}${type}`, graph },
        { subject, predicate: RDF_TYPE, object: `${EPCIS_CURRENT}${type}`, graph },
        { subject: 'urn:document', predicate: `${EPCIS_CURRENT}eventList`, object: subject, graph },
      ]),
      { subject: ids[1], predicate: `${DKG}epcisEventType`, object: `${EPCIS}${type}`, graph },
      { subject: ids[2], predicate: `${DKG}epcisEventType`, object: `${EPCIS_CURRENT}${type}`, graph },
      ...(visibility === 'private' ? ids.map(subject => ({
        subject, predicate: `${DKG}privateDataAnchor`, object: '"true"', graph: publicGraph,
      })) : []),
    ]);
    for (const eventType of [undefined, type, `${EPCIS}${type}`, `${EPCIS_CURRENT}${type}`]) {
      const rows = [];
      for (let offset = 0; offset <= ids.length; offset++) {
        const result = await store.query(buildEpcisQuery({ eventType, limit: 1, offset }, contextGraphId));
        if (result.type !== 'bindings') throw new Error('Expected event bindings');
        rows.push(...result.bindings);
      }
      expect(rows.map(row => row.event)).toEqual(ids);
      expect(rows.map(row => row.eventType)).toEqual([`${EPCIS_CURRENT}${type}`, `${EPCIS}${type}`, `${EPCIS_CURRENT}${type}`]);
      expect(rows.map(row => toEpcisEvent(row).type)).toEqual([type, type, type]);
    }
  } finally {
    await store.dropGraph(publicGraph);
    if (graph !== publicGraph) await store.dropGraph(graph);
    await store.close();
  }
}, 30_000);

it('paginates admitted events with missing and malformed times deterministically', async () => {
  const store = create();
  const graph = contextGraphDataUri(CG);
  const ids = ['valid', 'invalid', 'missing'];
  try {
    await store.insert([
      ...eventRows('valid', `${EPCIS}ObjectEvent`, '2024-03-01T08:00:00Z'),
      ...eventRows('invalid', `${EPCIS}ObjectEvent`, 'not-a-date'),
      ...eventRows('missing', `${EPCIS}ObjectEvent`),
      ...ids.map((id) => ({ subject: `urn:event:${id}`, predicate: `${DKG}epcisEventType`, object: `${EPCIS}ObjectEvent`, graph })),
    ]);
    for (let repeat = 0; repeat < 2; repeat++) {
      const pages = [];
      for (let offset = 0; offset < ids.length; offset++) {
        const result = await store.query(buildEpcisQuery({ limit: 1, offset }, CG));
        if (result.type !== 'bindings') throw new Error('Expected event bindings');
        pages.push(...result.bindings.map((row) => row.event));
      }
      expect(pages).toEqual(ids.map((id) => `urn:event:${id}`));
    }
  } finally { await store.dropGraph(graph); await store.close(); }
});

it.each([EPCIS, EPCIS_CURRENT])('admits anchored private SWM events with timing evidence in %s', async (namespace) => {
  const store = create();
  const publicGraph = contextGraphSharedMemoryUri(CG);
  const privateGraph = contextGraphPrivateUri(CG);
  try {
    await store.insert([
      ...['event', 'non-event'].flatMap((id) => [
        { subject: `urn:private:${id}`, predicate: RDF_TYPE, object: `${namespace}ObjectEvent`, graph: privateGraph },
        { subject: `urn:private:${id}`, predicate: `${DKG}privateDataAnchor`, object: '"true"', graph: publicGraph },
      ]),
      { subject: 'urn:private:event', predicate: `${namespace}eventTime`, object: '"2024-03-01T08:00:00Z"', graph: privateGraph },
      { subject: 'urn:public:unmarked', predicate: RDF_TYPE, object: `${namespace}ObjectEvent`, graph: publicGraph },
      { subject: 'urn:public:unmarked', predicate: `${namespace}eventTime`, object: '"2024-03-01T08:00:00Z"', graph: publicGraph },
    ]);
    const result = await store.query(buildEpcisQuery({ finalized: false }, CG));
    if (result.type !== 'bindings') throw new Error('Expected event bindings');
    expect(result.bindings.map((row) => row.event)).toEqual(['urn:private:event']);
  } finally {
    await store.dropGraph(publicGraph); await store.dropGraph(privateGraph); await store.close();
  }
});

it('projects a matched parent while preserving complete EPC lists on matching events', async () => {
  const store = create();
  const graph = contextGraphDataUri(CG);
  const subject = 'urn:event:multi-valued';
  try {
    await store.insert([
      ...eventRows('multi-valued', `${EPCIS}ObjectEvent`),
      ...eventRows('non-matching', `${EPCIS}ObjectEvent`),
      { subject: 'urn:event:non-matching', predicate: `${DKG}epcisEventType`, object: `${EPCIS}ObjectEvent`, graph },
      ...['parentID', 'childEPCs', 'inputEPCList', 'outputEPCList'].map(field => ({
        subject: 'urn:event:non-matching', predicate: `${EPCIS}${field}`, object: 'urn:C', graph,
      })),
      { subject, predicate: `${DKG}epcisEventType`, object: `${EPCIS}ObjectEvent`, graph },
      ...['parentID', 'childEPCs', 'inputEPCList', 'outputEPCList'].flatMap((field) => [
        { subject, predicate: `${EPCIS}${field}`, object: 'urn:A', graph },
        { subject, predicate: `${EPCIS_CURRENT}${field}`, object: 'urn:B', graph },
      ]),
    ]);
    const result = await store.query(buildEpcisQuery({ parentID: 'urn:A', childEPC: 'urn:A', inputEPC: 'urn:A', outputEPC: 'urn:A' }, CG));
    if (result.type !== 'bindings') throw new Error('Expected event bindings');
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].event).toBe(subject);
    const event = toEpcisEvent(result.bindings[0]);
    expect(event.parentID).toBe('urn:A');
    for (const field of ['childEPCs', 'inputEPCList', 'outputEPCList']) {
      expect((event[field] as string[]).sort()).toEqual(['urn:A', 'urn:B']);
    }
  } finally { await store.dropGraph(graph); await store.close(); }
});

it('captures the current namespace using the canonical standard discriminator', async () => {
  const store = create();
  const graph = contextGraphDataUri(CG);
  const eventID = 'urn:event:current-captured';
  const document = {
    '@context': { '@vocab': EPCIS_CURRENT, eventID: '@id' },
    type: 'EPCISDocument', schemaVersion: '2.0', creationDate: '2024-03-01T08:00:00Z',
    epcisBody: { eventList: [{ eventID, type: `${EPCIS_CURRENT}ObjectEvent`, action: 'OBSERVE',
      epcList: ['urn:item:current'], eventTime: '2024-03-01T08:00:00Z', eventTimeZoneOffset: '+00:00' }] },
  };
  try {
    await handleCaptureAsync({ epcisDocument: { public: document } }, {
      contextGraphId: CG,
      publisher: { publishAsync: async (_cg, content) => {
        const nquads = await jsonld.toRDF((content as { public: unknown }).public, { format: 'application/n-quads' });
        await store.update(`INSERT DATA { GRAPH <${graph}> { ${nquads} } }`);
        return { captureID: 'capture-current' };
      } },
    });
    const declared = await store.query(`SELECT ?type ?declared WHERE { GRAPH <${graph}> {
      <${eventID}> a ?type ; <${DKG}epcisEventType> ?declared . } }`);
    expect(declared.type === 'bindings' && declared.bindings).toEqual([
      { type: `${EPCIS}ObjectEvent`, declared: `${EPCIS}ObjectEvent` },
    ]);
    const result = await store.query(buildEpcisQuery({}, CG));
    if (result.type !== 'bindings') throw new Error('Expected event bindings');
    expect(result.bindings.map((row) => row.event)).toEqual([eventID]);
    expect(toEpcisEvent(result.bindings[0]).type).toBe('ObjectEvent');
  } finally { await store.dropGraph(graph); await store.close(); }
});

describe.each(['urn:epcis:CustomEvent', 'https://example.org/CustomEvent'])('external event class %s', (eventType) => {
  it.each(DATE_CASES)('requires event shape and preserves exact filtering $name', async ({ filters, expected }) => {
    const store = create();
    try {
      await store.insert([
        ...eventRows('event', eventType, '2024-03-01T08:00:00Z', '+00:00'),
        ...eventRows('early', eventType, '2023-03-01T08:00:00Z', '+00:00'),
        ...eventRows('late', eventType, '2025-03-01T08:00:00Z', '+00:00'),
        ...eventRows('ordinary', eventType),
        ...eventRows('missing-offset', eventType, '2024-03-01T08:00:00Z'),
        ...eventRows('missing-time', eventType, undefined, '+00:00'),
        ...eventRows('standard', `${EPCIS}ObjectEvent`, '2024-03-01T08:00:00Z', '+00:00'),
        { subject: 'urn:document', predicate: `${EPCIS}eventList`, object: 'urn:event:standard', graph: contextGraphDataUri(CG) },
      ]);
      const responseType = toEpcisEvent({ eventType }).type as string;
      expect(responseType).toBe(eventType);
      const sparql = buildEpcisQuery({ ...filters, eventType: responseType }, CG);
      expect(sparql).toContain(`FILTER(?eventType IN (<${eventType}>))`);
      expect(sparql.split('OPTIONAL { ?event <http://dkg.io/ontology/epcisEventType> ?_declaredEventType . }')).toHaveLength(3);
      for (const field of ['eventTime', 'eventTimeZoneOffset']) {
        expect(sparql).not.toContain(`OPTIONAL { VALUES ?_epcis_${field}_value`);
        // One binding in each public/private graph branch, even with date filters.
        expect(sparql.split(`?event ?_epcis_${field}_value ?${field} .`)).toHaveLength(3);
      }
      const result = await store.query(sparql);
      if (result.type !== 'bindings') throw new Error('Expected event bindings');
      expect(result.bindings.map((row) => row.event).sort())
        .toEqual(expected.map((id) => `urn:event:${id}`));

      const defaultResult = await store.query(buildEpcisQuery(filters, CG));
      if (defaultResult.type !== 'bindings') throw new Error('Expected default event bindings');
      expect(defaultResult.bindings.map((row) => row.event)).toEqual(['urn:event:standard']);
    } finally {
      await store.dropGraph(contextGraphDataUri(CG)); await store.close();
    }
  });
});

const jsonld = createRequire(import.meta.url)('jsonld') as {
  toRDF(document: unknown, options: { format: 'application/n-quads' }): Promise<string>;
};

it.each(['https://example.org/TemperatureEvent', 'urn:epcis:TemperatureEvent'].flatMap((eventType) =>
  ['overridden', 'omitted'].map((mapping) => ({ eventType, mapping })),
))('captures and queries the exact external class $eventType with type mapping $mapping', async ({ eventType, mapping }) => {
  const store = create();
  const eventID = 'urn:event:external-captured';
  const document = {
    '@context': { '@vocab': EPCIS, eventID: '@id', ...(mapping === 'overridden' ? { type: '@type' } : {}) },
    type: 'EPCISDocument', schemaVersion: '2.0', creationDate: '2024-03-01T08:00:00Z',
    epcisBody: { eventList: [{
      ...(mapping === 'overridden' ? { '@context': { type: 'https://example.org/discriminator' } } : {}),
      '@type': 'urn:example:ExistingType', type: eventType, eventID,
      eventTime: '2024-03-01T08:00:00Z', eventTimeZoneOffset: '+00:00',
    }] },
  };
  const original = structuredClone(document);
  try {
    await handleCaptureAsync({ epcisDocument: { public: document } }, {
      contextGraphId: CG,
      publisher: { publishAsync: async (_cg, content) => {
        const nquads = await jsonld.toRDF((content as { public: unknown }).public, { format: 'application/n-quads' });
        await store.update(`INSERT DATA { GRAPH <${contextGraphDataUri(CG)}> { ${nquads} } }`);
        return { captureID: 'capture-external' };
      } },
    });
    expect(document).toEqual(original);
    const classResult = await store.query(`SELECT ?type WHERE { GRAPH <${contextGraphDataUri(CG)}> { <${eventID}> a ?type } }`);
    if (classResult.type !== 'bindings') throw new Error('Expected class bindings');
    expect(classResult.bindings.map((row) => row.type).sort()).toEqual([eventType, 'urn:example:ExistingType'].sort());
    const result = await store.query(buildEpcisQuery({ eventType }, CG));
    if (result.type !== 'bindings') throw new Error('Expected event bindings');
    expect(result.bindings.map((row) => row.event)).toEqual([eventID]);
    expect(toEpcisEvent(result.bindings[0]).type).toBe(eventType);
    const unfiltered = await store.query(buildEpcisQuery({}, CG));
    expect(unfiltered.type === 'bindings' && unfiltered.bindings.filter(row => row.event === eventID).map(row => row.eventType)).toEqual([eventType]);
  } finally { await store.dropGraph(contextGraphDataUri(CG)); await store.close(); }
});

it.each(['public', 'private'] as const)('keeps auxiliary EPCIS classes with one declared event per page after %s capture', async visibility => {
  const store = create();
  const publicGraph = contextGraphDataUri(CG);
  const graph = visibility === 'private' ? `${publicGraph}/_private` : publicGraph;
  const events = [
    { eventID: 'urn:declared:first', type: `${EPCIS}DeclaredEvent`, action: 'OBSERVE', epcList: ['urn:item:first'], '@type': `${EPCIS}CustomEvent`, eventTime: '2024-03-02T08:00:00Z', eventTimeZoneOffset: '+00:00' },
    { eventID: 'urn:declared:second', type: `${EPCIS}DeclaredEvent`, action: 'OBSERVE', epcList: ['urn:item:second'], '@type': [`${EPCIS}AssociationEvent`, 'urn:example:Auxiliary'], eventTime: '2024-03-01T08:00:00Z', eventTimeZoneOffset: '+00:00' },
  ];
  const document = {
    '@context': { '@vocab': EPCIS, eventID: '@id' },
    type: 'EPCISDocument', schemaVersion: '2.0', creationDate: '2024-03-02T08:00:00Z',
    epcisBody: { eventList: events },
  };
  try {
    await handleCaptureAsync({ epcisDocument: { [visibility]: document } }, {
      contextGraphId: CG,
      publisher: { publishAsync: async (_cg, content) => {
        const nquads = await jsonld.toRDF((content as Record<string, unknown>)[visibility], { format: 'application/n-quads' });
        await store.update(`INSERT DATA { GRAPH <${graph}> { ${nquads} } }`);
        if (visibility === 'private') await store.insert(events.map(event => ({
          subject: event.eventID, predicate: 'http://dkg.io/ontology/privateDataAnchor', object: '"true"', graph: publicGraph,
        })));
        return { captureID: 'capture-discriminator' };
      } },
    });
    const classes = await store.query(`SELECT ?type WHERE { GRAPH <${graph}> { <urn:declared:first> a ?type } }`);
    expect(classes.type === 'bindings' && classes.bindings.map(row => row.type).sort())
      .toEqual([`${EPCIS}CustomEvent`, `${EPCIS}DeclaredEvent`]);
    const all = await store.query(buildEpcisQuery({}, CG));
    expect(all.type === 'bindings' && all.bindings.map(row => row.event)).toEqual(events.map(event => event.eventID));
    const queryEngine = { query: async (sparql: string) => {
      const result = await store.query(sparql);
      if (result.type !== 'bindings') throw new Error('Expected event bindings');
      return { bindings: result.bindings };
    } };
    const config = { contextGraphId: CG, queryEngine, basePath: '/api/epcis/events' };
    const first = await handleEventsQuery(new URLSearchParams('perPage=1'), config);
    const second = await handleEventsQuery(new URLSearchParams('perPage=1&offset=1'), config);
    const rows = [first, second].map(page => page.body.epcisBody.queryResults.resultsBody.eventList);
    expect(rows.map(events => events.map(event => event.type))).toEqual([[`${EPCIS}DeclaredEvent`], [`${EPCIS}DeclaredEvent`]]);
    expect(first.headers?.link).toBeDefined();
    expect(second.headers?.link).toBeUndefined();
    const aux = await store.query(buildEpcisQuery({ eventType: `${EPCIS}CustomEvent` }, CG));
    expect(aux.type === 'bindings' && aux.bindings).toEqual([]);
  } finally { await store.dropGraph(publicGraph); if (graph !== publicGraph) await store.dropGraph(graph); await store.close(); }
});

it.each(['public', 'private'] as const)('rejects forged reserved declarations before %s publication', async visibility => {
  const document = {
    '@context': { '@vocab': EPCIS, eventID: '@id' },
    type: 'EPCISDocument', schemaVersion: '2.0', creationDate: '2024-03-01T08:00:00Z',
    epcisBody: { eventList: [{
      eventID: 'urn:event:forged', type: 'ObjectEvent', action: 'OBSERVE', epcList: [],
      eventTime: '2024-03-01T08:00:00Z', eventTimeZoneOffset: '+00:00',
      'https://example.org/extension': {
        '@id': 'urn:event:forged', '@type': `${EPCIS}CustomEvent`,
        'http://dkg.io/ontology/epcisEventType': { '@id': `${EPCIS}CustomEvent` },
      },
    }] },
  };
  let published = false;
  await expect(handleCaptureAsync({ epcisDocument: { [visibility]: document } }, {
    contextGraphId: CG,
    publisher: { publishAsync: async () => { published = true; return { captureID: 'must-not-publish' }; } },
  })).rejects.toThrow('reserved');
  expect(published).toBe(false);
});

});
