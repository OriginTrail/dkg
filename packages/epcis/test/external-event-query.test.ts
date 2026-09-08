import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, BlazegraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { buildEpcisQuery } from '../src/query-builder.js';
import { handleCaptureAsync, handleEventsQuery, toEpcisEvent } from '../src/handlers.js';

const CG = 'external-epcis-type';
const EPCIS = 'https://gs1.github.io/EPCIS/';
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
      ]);
      const responseType = toEpcisEvent({ eventType }).type as string;
      expect(responseType).toBe(eventType);
      const sparql = buildEpcisQuery({ ...filters, eventType: responseType }, CG);
      expect(sparql).toContain(`FILTER(?eventType = <${eventType}>)`);
      for (const field of ['eventTime', 'eventTimeZoneOffset']) {
        expect(sparql).not.toContain(`OPTIONAL { ?event epcis:${field} ?${field} . }`);
        // One binding in each public/private graph branch, even with date filters.
        expect(sparql.split(`?event epcis:${field} ?${field} .`)).toHaveLength(3);
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

});
