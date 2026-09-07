import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { BlazegraphStore, OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { buildEpcisQuery } from '../src/query-builder.js';

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

for (const backend of backends) {
  describe(`EPCIS event classification (${backend.name})`, () => {
    it.each([
      { finalized: true },
      { finalized: false },
      { finalized: true, subGraphName: 'supply-chain' },
      { finalized: false, subGraphName: 'supply-chain' },
    ])('returns only event classes in public and anchored private data: %j', async (params) => {
      const store = backend.create();
      const cg = `epcis-classification-${randomUUID()}`;
      const dataGraph = `did:dkg:context-graph:${cg}`;
      const scope = `${dataGraph}${params.subGraphName ? `/${params.subGraphName}` : ''}`;
      const publicGraph = params.finalized ? scope : `${scope}/_shared_memory`;
      const privateGraph = `${scope}/_private`;
      const metaGraph = params.finalized ? `${dataGraph}/_meta` : `${scope}/_shared_memory_meta`;
      const standardTypes = ['ObjectEvent', 'AggregationEvent', 'TransactionEvent', 'TransformationEvent', 'AssociationEvent'];
      const eventTypes = [...standardTypes.map((type) => `https://gs1.github.io/EPCIS/${type}`),
        'https://gs1.github.io/EPCIS/CustomEvent', 'https://example.org/Observation', 'urn:epcis:Observation'];
      try {
        const quads: Quad[] = [publicGraph, privateGraph].flatMap((graph) => {
          const visibility = graph === publicGraph ? 'public' : 'private';
          const subjectFor = (index: number) => `urn:test:${visibility}:event-${index}`;
          const records = [
            ...eventTypes.map((type, index) => ({ subject: subjectFor(index), type, member: index === 0 || index >= standardTypes.length, root: index > 0 && index < standardTypes.length })),
            ...['EPCISDocument', 'EPCISQueryDocument', 'SensorElement'].map((name) => ({
              subject: `urn:test:${visibility}:${name}`, type: `https://gs1.github.io/EPCIS/${name}`, member: false, root: false,
            })),
            { subject: `urn:test:${visibility}:orphan-standard`, type: eventTypes[0], member: false, root: false },
            // Both nested resources have type/time/offset; neither belongs to eventList.
            { subject: `urn:test:${visibility}:nested-custom`, type: 'https://example.org/Observation', member: false, root: false },
            { subject: `urn:test:${visibility}:nested-standard`, type: eventTypes[0], member: false, root: false },
          ];
          return records.flatMap(({ subject, type, member, root }) => [
            { subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: type, graph },
            { subject, predicate: 'https://gs1.github.io/EPCIS/eventTime', object: '"2024-03-01T08:00:00Z"', graph },
            { subject, predicate: 'https://gs1.github.io/EPCIS/eventTimeZoneOffset', object: '"+00:00"', graph },
            ...(root ? [
              { subject: `urn:publication:${subject}`, predicate: 'http://dkg.io/ontology/rootEntity', object: subject, graph: metaGraph },
              ...(subject.endsWith('event-1') ? [{ subject: `urn:publication:${subject}`, predicate: 'http://dkg.io/ontology/partOf', object: 'urn:legacy:ual', graph: metaGraph }] : []),
              ...(subject.endsWith('event-2') ? [{ subject: `urn:publication:${subject}`, predicate: 'http://dkg.io/ontology/batchId', object: '"1"', graph: metaGraph }] : []),
            ] : []),
            ...(member ? [{ subject: `urn:test:${visibility}:body`, predicate: `${visibility === 'public' ? 'https://gs1.github.io/EPCIS/' : 'https://ref.gs1.org/epcis/'}eventList`, object: subject, graph }] : []),
            ...(subject.includes('nested-') ? [{ subject: subjectFor(7), predicate: 'https://example.org/detail', object: subject, graph }] : []),
            ...(graph === privateGraph ? [{ subject, predicate: 'http://dkg.io/ontology/privateDataAnchor', object: '"true"', graph: publicGraph }] : []),
          ]);
        });
        await store.insert(quads);
        const all = await store.query(buildEpcisQuery(params, cg));
        expect(all.type).toBe('bindings');
        if (all.type !== 'bindings') throw new Error('Expected event bindings');
        expect(all.bindings).toHaveLength(eventTypes.length * 2);
        expect(all.bindings.map((row) => row.event).sort()).toEqual(
          ['public', 'private'].flatMap((partition) => eventTypes.map((_type, index) => `urn:test:${partition}:event-${index}`)).sort(),
        );
        // Both supported historical provenance layouts still resolve their UAL.
        for (const visibility of ['public', 'private']) {
          expect(all.bindings.find((row) => row.event === `urn:test:${visibility}:event-1`)?.ual)
            .toBe('urn:legacy:ual');
          expect(all.bindings.find((row) => row.event === `urn:test:${visibility}:event-2`)?.ual)
            .toBe(`urn:publication:urn:test:${visibility}:event-2`);
        }
        // A different publisher can reference a legacy event without hiding it.
        await store.insert([publicGraph, privateGraph].map((graph) => ({
          subject: 'urn:shipment:unrelated', predicate: 'https://example.org/relatedEvent',
          object: `urn:test:${graph === publicGraph ? 'public' : 'private'}:event-1`, graph,
        })));
        const referenced = await store.query(buildEpcisQuery(params, cg));
        expect(referenced).toEqual(all);
        const filtered = await store.query(buildEpcisQuery({ ...params, eventType: 'ObjectEvent' }, cg));
        expect(filtered.type).toBe('bindings');
        if (filtered.type !== 'bindings') throw new Error('Expected event bindings');
        expect(filtered.bindings.map((row) => row.event).sort()).toEqual(['urn:test:private:event-0', 'urn:test:public:event-0']);
        for (const eventType of eventTypes) {
          const result = await store.query(buildEpcisQuery({ ...params, eventType }, cg));
          expect(result.type).toBe('bindings');
          if (result.type !== 'bindings') throw new Error('Expected event bindings');
          expect(result.bindings).toHaveLength(2);
          expect(result.bindings.every((row) => row.eventType === eventType)).toBe(true);
        }
        const documents = await store.query(buildEpcisQuery({ ...params, eventType: 'https://gs1.github.io/EPCIS/EPCISDocument' }, cg));
        expect(documents).toMatchObject({ type: 'bindings', bindings: [] });
      } finally {
        try {
          for (const graph of [publicGraph, privateGraph, metaGraph]) await store.dropGraph(graph);
        } finally {
          await store.close();
        }
      }
    }, 60_000);

  });
}
