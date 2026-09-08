import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { BlazegraphStore, OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { buildEpcisQuery, createEpcisQueryPlan } from '../src/query-builder.js';
import { handleEventsQuery } from '../src/handlers.js';
import type { EpcisQueryParams } from '../src/types.js';

const blazegraphUrl = process.env.BLAZEGRAPH_TEST_URL;
if (process.env.DKG_REQUIRE_BLAZEGRAPH === '1' && !blazegraphUrl) {
  throw new Error('The live EPCIS classification lane requires BLAZEGRAPH_TEST_URL');
}
const backends: Array<{ name: string; create: () => TripleStore }> = [
  { name: 'Oxigraph', create: () => new OxigraphStore() },
];
// Local runs always exercise Oxigraph. The live CI profile adds Blazegraph;
// its required-URL guard above prevents a green run with the backend missing.
if (blazegraphUrl) backends.push({ name: 'Blazegraph', create: () => new BlazegraphStore(blazegraphUrl) });

const EPCIS = 'https://gs1.github.io/EPCIS/';
const EPCIS_CURRENT = 'https://ref.gs1.org/epcis/';
const DKG = 'http://dkg.io/ontology/';
const VISIBILITIES = ['public', 'private'] as const;
type Visibility = typeof VISIBILITIES[number];
interface EventCase {
  id: string;
  type: string;
  membership: 'event-list' | 'none';
  provenance: 'none' | 'root-only' | 'per-token' | 'collapsed-ual';
  expected: boolean;
  nestedUnder?: string;
}
const EVENT_CASES: readonly EventCase[] = [
  { id: 'object-member', type: `${EPCIS}ObjectEvent`, membership: 'event-list', provenance: 'none', expected: true },
  { id: 'aggregation-per-token', type: `${EPCIS}AggregationEvent`, membership: 'none', provenance: 'per-token', expected: true },
  { id: 'transaction-collapsed', type: `${EPCIS}TransactionEvent`, membership: 'none', provenance: 'collapsed-ual', expected: true },
  { id: 'transformation-root', type: `${EPCIS}TransformationEvent`, membership: 'none', provenance: 'root-only', expected: true },
  { id: 'association-root', type: `${EPCIS}AssociationEvent`, membership: 'none', provenance: 'root-only', expected: true },
  { id: 'custom-member', type: `${EPCIS}CustomEvent`, membership: 'event-list', provenance: 'none', expected: true },
  { id: 'https-member', type: 'https://example.org/Observation', membership: 'event-list', provenance: 'none', expected: true },
  { id: 'urn-member', type: 'urn:epcis:Observation', membership: 'event-list', provenance: 'none', expected: true },
  { id: 'document', type: `${EPCIS}EPCISDocument`, membership: 'none', provenance: 'none', expected: false },
  { id: 'query-document', type: `${EPCIS}EPCISQueryDocument`, membership: 'none', provenance: 'none', expected: false },
  { id: 'sensor-element', type: `${EPCIS}SensorElement`, membership: 'none', provenance: 'none', expected: false },
  { id: 'orphan-standard', type: `${EPCIS}ObjectEvent`, membership: 'none', provenance: 'none', expected: false },
  { id: 'nested-custom', type: 'https://example.org/Observation', membership: 'none', provenance: 'none', expected: false, nestedUnder: 'urn-member' },
  { id: 'nested-standard', type: `${EPCIS}ObjectEvent`, membership: 'none', provenance: 'none', expected: false, nestedUnder: 'urn-member' },
];
interface FixtureGraphs {
  public: string;
  private: string;
  meta: string;
}
function eventSubject(visibility: Visibility, id: string): string {
  return `urn:test:${visibility}:${id}`;
}
function publicationSubject(visibility: Visibility, id: string): string {
  return `urn:publication:${eventSubject(visibility, id)}`;
}
function eventQuads(event: EventCase, visibility: Visibility, graphs: FixtureGraphs, namespace = EPCIS): Quad[] {
  const subject = eventSubject(visibility, event.id);
  const graph = graphs[visibility];
  const quads: Quad[] = [
    { subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: event.type.replace(EPCIS, namespace), graph },
    { subject, predicate: `${namespace}eventTime`, object: '"2024-03-01T08:00:00Z"', graph },
    { subject, predicate: `${namespace}eventTimeZoneOffset`, object: '"+00:00"', graph },
  ];
  if (event.provenance !== 'none') {
    const publication = publicationSubject(visibility, event.id);
    quads.push({ subject: publication, predicate: `${DKG}rootEntity`, object: subject, graph: graphs.meta });
    if (event.provenance === 'per-token') {
      quads.push({ subject: publication, predicate: `${DKG}partOf`, object: 'urn:legacy:ual', graph: graphs.meta });
    } else if (event.provenance === 'collapsed-ual') {
      quads.push({ subject: publication, predicate: `${DKG}batchId`, object: '"1"', graph: graphs.meta });
    }
  }
  if (event.membership === 'event-list') {
    quads.push({ subject: `urn:test:${visibility}:body`, predicate: `${namespace}eventList`, object: subject, graph });
  }
  if (event.nestedUnder) {
    quads.push({ subject: eventSubject(visibility, event.nestedUnder), predicate: 'https://example.org/detail', object: subject, graph });
  }
  if (visibility === 'private') {
    quads.push({ subject, predicate: `${DKG}privateDataAnchor`, object: '"true"', graph: graphs.public });
  }
  return quads;
}
function expectedSubjects(): string[] {
  return VISIBILITIES.flatMap((visibility) => EVENT_CASES
    .filter((event) => event.expected)
    .map((event) => eventSubject(visibility, event.id))).sort();
}
async function queryEvents(store: TripleStore, cg: string, params: EpcisQueryParams) {
  const { finalized = true, subGraphName, limit, offset, perPage: _perPage, ...filters } = params;
  const plan = createEpcisQueryPlan(filters, { contextGraphId: cg, finalized, subGraphName }, { limit: limit ?? 100, offset: offset ?? 0 });
  expect(plan.sparql).toBe(buildEpcisQuery(params, cg));
  expect(plan.options).toEqual({ contextGraphId: cg, subGraphName, graphSuffix: finalized ? undefined : '_shared_memory', includePrivate: true });
  const result = await store.query(plan.sparql);
  if (result.type !== 'bindings') throw new Error('Expected event bindings');
  return result.bindings;
}

for (const backend of backends) {
  describe(`EPCIS event classification (${backend.name})`, () => {
    it('orders mixed timestamp datatypes by instant across vocabulary versions', async () => {
      const store = backend.create();
      const cg = `epcis-time-order-${randomUUID()}`;
      const graph = `did:dkg:context-graph:${cg}`;
      const events = [
        { id: 'latest', namespace: EPCIS_CURRENT, time: '"2024-03-01T08:30:00-02:00"^^<http://www.w3.org/2001/XMLSchema#dateTimeStamp>' },
        { id: 'middle', namespace: EPCIS, time: '"2024-03-01T09:00:00Z"' },
        { id: 'earliest', namespace: EPCIS_CURRENT, time: '"2024-03-01T11:00:00+04:00"^^<http://www.w3.org/2001/XMLSchema#dateTime>' },
      ];
      try {
        await store.insert(events.flatMap(({ id, namespace, time }) => [
          { subject: `urn:event:${id}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${namespace}ObjectEvent`, graph },
          { subject: 'urn:document:body', predicate: `${namespace}eventList`, object: `urn:event:${id}`, graph },
          { subject: `urn:event:${id}`, predicate: `${namespace}eventTime`, object: time, graph },
        ]));
        const rows = await queryEvents(store, cg, {});
        expect(rows.map(row => row.event)).toEqual(events.map(({ id }) => `urn:event:${id}`));
      } finally { await store.dropGraph(graph); await store.close(); }
    });

    it.each([EPCIS, EPCIS_CURRENT])('projects and filters all standard properties in %s', async (namespace) => {
      const store = backend.create();
      const cg = `epcis-properties-${randomUUID()}`;
      const graph = `did:dkg:context-graph:${cg}`;
      const subject = 'urn:event:complete';
      const iri = (value: string) => namespace === EPCIS_CURRENT ? value : `"${value}"`;
      // The official EPCIS 2.0 context types EPC identifiers as @id and time as
      // xsd:dateTimeStamp. Retain the historical literal identifier representation too.
      const properties: Record<string, string> = {
        eventTime: '"2024-03-01T08:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTimeStamp>',
        eventTimeZoneOffset: '"+00:00"', action: '"ADD"',
        epcList: iri('urn:epc:item'), parentID: iri('urn:epc:parent'),
        childEPCs: iri('urn:epc:child'), inputEPCList: iri('urn:epc:input'), outputEPCList: iri('urn:epc:output'),
        bizStep: 'https://ref.gs1.org/cbv/BizStep-receiving',
        disposition: 'https://ref.gs1.org/cbv/Disp-in_progress',
        readPoint: 'urn:read:point', bizLocation: 'urn:business:location',
      };
      try {
        await store.insert([
          { subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${namespace}ObjectEvent`, graph },
          { subject: 'urn:document:body', predicate: `${namespace}eventList`, object: subject, graph },
          ...Object.entries(properties).map(([name, object]) => ({ subject, predicate: `${namespace}${name}`, object, graph })),
        ]);
        const query = async (params: Record<string, string> = {}) => handleEventsQuery(new URLSearchParams(params), {
          contextGraphId: cg, basePath: '/api/epcis/events', queryEngine: {
            query: async (sparql) => {
              const result = await store.query(sparql);
              if (result.type !== 'bindings') throw new Error('Expected event bindings');
              return { bindings: result.bindings };
            },
          },
        });
        const events = (await query()).body.epcisBody.queryResults.resultsBody.eventList;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: 'ObjectEvent', eventTime: '2024-03-01T08:00:00Z', eventTimeZoneOffset: '+00:00', action: 'ADD',
          epcList: ['urn:epc:item'], parentID: 'urn:epc:parent', childEPCs: ['urn:epc:child'],
          inputEPCList: ['urn:epc:input'], outputEPCList: ['urn:epc:output'],
          bizStep: properties.bizStep, disposition: properties.disposition,
          readPoint: { id: 'urn:read:point' }, bizLocation: { id: 'urn:business:location' },
        });
        const filters: Array<Record<string, string>> = [
          { eventType: 'ObjectEvent' }, { eventType: `${EPCIS}ObjectEvent` }, { eventType: `${EPCIS_CURRENT}ObjectEvent` },
          { epc: 'urn:epc:item' }, { epc: 'urn:epc:child' },
          ...['item', 'parent', 'child', 'input', 'output'].map(value => ({ anyEPC: `urn:epc:${value}` })),
          { parentID: 'urn:epc:parent' }, { childEPC: 'urn:epc:child' },
          { inputEPC: 'urn:epc:input' }, { outputEPC: 'urn:epc:output' },
          { from: '2024-03-01T00:00:00Z', to: '2024-03-02T00:00:00Z' },
          { action: 'ADD' }, { bizStep: 'receiving' }, { disposition: 'in_progress' },
          { readPoint: 'urn:read:point' }, { bizLocation: 'urn:business:location' },
        ];
        for (const filter of filters) {
          const result = (await query(filter)).body.epcisBody.queryResults.resultsBody.eventList;
          expect(result, JSON.stringify(filter)).toEqual(events);
        }
        expect((await query({ to: '2024-03-01T08:00:00Z' })).body.epcisBody.queryResults.resultsBody.eventList).toEqual([]);
        expect((await query({ anyEPC: 'urn:epc:absent' })).body.epcisBody.queryResults.resultsBody.eventList).toEqual([]);
      } finally { await store.dropGraph(graph); await store.close(); }
    });

    it.each([
      { finalized: true },
      { finalized: false },
      { finalized: true, subGraphName: 'supply-chain' },
      { finalized: false, subGraphName: 'supply-chain' },
    ].flatMap(scope => [EPCIS, EPCIS_CURRENT].map(namespace => ({ ...scope, namespace }))))('returns only event classes in public and anchored private data: %j', async ({ namespace, ...params }) => {
      const store = backend.create();
      const cg = `epcis-classification-${randomUUID()}`;
      const dataGraph = `did:dkg:context-graph:${cg}`;
      const scope = `${dataGraph}${params.subGraphName ? `/${params.subGraphName}` : ''}`;
      const graphs: FixtureGraphs = {
        public: params.finalized ? scope : `${scope}/_shared_memory`,
        private: `${scope}/_private`,
        meta: params.finalized ? `${dataGraph}/_meta` : `${scope}/_shared_memory_meta`,
      };
      try {
        await store.insert(VISIBILITIES.flatMap((visibility) => EVENT_CASES.flatMap((event) => eventQuads(event, visibility, graphs, namespace))));
        const all = await queryEvents(store, cg, params);
        expect(all.map((row) => row.event).sort()).toEqual(expectedSubjects());

        // Both historical provenance layouts resolve a UAL in both partitions.
        for (const visibility of VISIBILITIES) {
          expect(all.find((row) => row.event === eventSubject(visibility, 'aggregation-per-token'))?.ual).toBe('urn:legacy:ual');
          expect(all.find((row) => row.event === eventSubject(visibility, 'transaction-collapsed'))?.ual)
            .toBe(publicationSubject(visibility, 'transaction-collapsed'));
        }

        // An unrelated publisher's incoming link must not hide a legacy root.
        await store.insert(VISIBILITIES.map((visibility) => ({
          subject: 'urn:shipment:unrelated', predicate: 'https://example.org/relatedEvent',
          object: eventSubject(visibility, 'aggregation-per-token'), graph: graphs[visibility],
        })));
        expect(await queryEvents(store, cg, params)).toEqual(all);

        const filtered = await queryEvents(store, cg, { ...params, eventType: 'ObjectEvent' });
        expect(filtered.map((row) => row.event).sort())
          .toEqual(VISIBILITIES.map((visibility) => eventSubject(visibility, 'object-member')).sort());
        for (const event of EVENT_CASES.filter((event) => event.expected)) {
          const type = event.type.replace(EPCIS, namespace);
          const rows = await queryEvents(store, cg, { ...params, eventType: type });
          expect(rows).toHaveLength(2);
          expect(rows.every((row) => row.eventType === type)).toBe(true);
        }
        expect(await queryEvents(store, cg, { ...params, eventType: `${EPCIS}EPCISDocument` })).toEqual([]);
      } finally {
        try {
          for (const graph of Object.values(graphs)) await store.dropGraph(graph);
        } finally {
          await store.close();
        }
      }
    }, 60_000);
  });
}
