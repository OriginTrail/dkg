/**
 * Regression test for OriginTrail/dkg#633.
 *
 * Private payloads are encrypted between nodes, but once an authorised
 * receiving node decrypts a payload it must insert normal plaintext RDF into
 * its local private graph. The triple store must not wrap literals in a second
 * `enc:gcm:v1` layer, because that breaks SPARQL filters and leaks ciphertext
 * through query results.
 */
import { describe, it, expect } from 'vitest';
import {
  ContextGraphManager,
  OxigraphStore,
  PrivateContentStore,
} from '@origintrail-official/dkg-storage';
import {
  contextGraphPrivateUri,
  contextGraphSharedMemoryUri,
} from '@origintrail-official/dkg-core';
import { buildEpcisQuery } from '@origintrail-official/dkg-epcis';

const CG = 'repro-633';
const ROOT = 'urn:example:asset:123';
const DETAIL = `${ROOT}/.well-known/genid/detail`;
const PRIVATE_GRAPH = contextGraphPrivateUri(CG);
const SWM_GRAPH = contextGraphSharedMemoryUri(CG);
const EVENT = 'urn:uuid:repro-633-epcis-event';
const EPC = 'urn:acme:bike:item:BIKE-2026-W18-0001';

describe('OriginTrail/dkg#633 — private graph stores plaintext RDF terms', () => {
  it('keeps literals, IRIs, and blank nodes queryable in the raw private graph', async () => {
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    const quads = [
      {
        subject: ROOT,
        predicate: 'http://example.com/ns/status',
        object: '<http://example.com/status/Ready>',
        graph: '',
      },
      {
        subject: ROOT,
        predicate: 'http://example.com/ns/temperature',
        object: '"7.5"^^<http://www.w3.org/2001/XMLSchema#decimal>',
        graph: '',
      },
      {
        subject: ROOT,
        predicate: 'http://example.com/ns/batch',
        object: '"batch-42"',
        graph: '',
      },
      {
        subject: ROOT,
        predicate: 'http://example.com/ns/detail',
        object: '_:detail',
        graph: '',
      },
      {
        subject: DETAIL,
        predicate: 'http://example.com/ns/note',
        object: '"blank-node-shaped private data"',
        graph: '',
      },
    ];

    await ps.storePrivateTriples(CG, ROOT, quads);
    await ps.storePrivateTriples(
      CG,
      ROOT,
      quads.filter((q) => q.object !== '_:detail'),
    );

    const raw = await store.query(`
      SELECT ?p ?o WHERE {
        GRAPH <${PRIVATE_GRAPH}> { <${ROOT}> ?p ?o . }
      }
      ORDER BY ?p ?o
    `);
    expect(raw.type).toBe('bindings');
    if (raw.type !== 'bindings') return;

    const rawObjects = raw.bindings.map((row) => row['o']);
    expect(rawObjects.some((o) => o?.startsWith('"enc:gcm:v1:'))).toBe(false);
    expect(rawObjects).toContain('http://example.com/status/Ready');
    expect(rawObjects).toContain('"7.5"^^<http://www.w3.org/2001/XMLSchema#decimal>');
    expect(rawObjects).toContain('"batch-42"');
    expect(rawObjects.some((o) => o?.startsWith('_:'))).toBe(true);
    expect(raw.bindings).toHaveLength(4);

    const filteredLiteral = await store.query(`
      SELECT ?s WHERE {
        GRAPH <${PRIVATE_GRAPH}> {
          ?s <http://example.com/ns/batch> "batch-42" .
        }
      }
    `);
    expect(filteredLiteral.type).toBe('bindings');
    if (filteredLiteral.type !== 'bindings') return;
    expect(filteredLiteral.bindings.map((row) => row['s'])).toEqual([ROOT]);

    const filteredTypedLiteral = await store.query(`
      SELECT ?s WHERE {
        GRAPH <${PRIVATE_GRAPH}> {
          ?s <http://example.com/ns/temperature> ?temperature .
          FILTER(?temperature >= "7.0"^^<http://www.w3.org/2001/XMLSchema#decimal>)
        }
      }
    `);
    expect(filteredTypedLiteral.type).toBe('bindings');
    if (filteredTypedLiteral.type !== 'bindings') return;
    expect(filteredTypedLiteral.bindings.map((row) => row['s'])).toEqual([ROOT]);

    const filteredIri = await store.query(`
      SELECT ?s WHERE {
        GRAPH <${PRIVATE_GRAPH}> {
          ?s <http://example.com/ns/status> <http://example.com/status/Ready> .
        }
      }
    `);
    expect(filteredIri.type).toBe('bindings');
    if (filteredIri.type !== 'bindings') return;
    expect(filteredIri.bindings.map((row) => row['s'])).toEqual([ROOT]);

    const roundTrippedObjects = (await ps.getPrivateTriples(CG, ROOT)).map(
      (q) => q.object,
    );
    expect(roundTrippedObjects).toContain('<http://example.com/status/Ready>');
    expect(roundTrippedObjects).toContain('"7.5"^^<http://www.w3.org/2001/XMLSchema#decimal>');
    expect(roundTrippedObjects).toContain('"batch-42"');
    expect(roundTrippedObjects).toContain('"blank-node-shaped private data"');
    expect(roundTrippedObjects.some((o) => o.startsWith('_:'))).toBe(true);
  });

  it('keeps EPCIS private event filters working through buildEpcisQuery', async () => {
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    await store.insert([
      {
        subject: EVENT,
        predicate: 'http://dkg.io/ontology/privateDataAnchor',
        object: '"true"',
        graph: SWM_GRAPH,
      },
    ]);
    await ps.storePrivateTriples(CG, EVENT, [
      {
        subject: EVENT,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: '<https://gs1.github.io/EPCIS/ObjectEvent>',
        graph: '',
      },
      {
        subject: EVENT,
        predicate: 'https://gs1.github.io/EPCIS/eventTime',
        object: '"2026-05-12T10:00:00.000Z"',
        graph: '',
      },
      {
        subject: EVENT,
        predicate: 'https://gs1.github.io/EPCIS/action',
        object: '"OBSERVE"',
        graph: '',
      },
      {
        subject: EVENT,
        predicate: 'https://gs1.github.io/EPCIS/bizStep',
        object: '<https://ref.gs1.org/cbv/BizStep-inspecting>',
        graph: '',
      },
      {
        subject: EVENT,
        predicate: 'https://gs1.github.io/EPCIS/disposition',
        object: '<https://ref.gs1.org/cbv/Disp-in_progress>',
        graph: '',
      },
      {
        subject: EVENT,
        predicate: 'https://gs1.github.io/EPCIS/epcList',
        object: `"${EPC}"`,
        graph: '',
      },
      {
        subject: EVENT,
        predicate: 'https://gs1.github.io/EPCIS/readPoint',
        object: '<urn:acme:bike:station:FunctionalTest>',
        graph: '',
      },
      {
        subject: EVENT,
        predicate: 'https://gs1.github.io/EPCIS/bizLocation',
        object: '<urn:acme:bike:station:FunctionalTest>',
        graph: '',
      },
    ]);

    const cases: Array<[string, Parameters<typeof buildEpcisQuery>[0]]> = [
      ['no filters', { finalized: false }],
      ['eventType=ObjectEvent', { finalized: false, eventType: 'ObjectEvent' }],
      ['action=OBSERVE', { finalized: false, action: 'OBSERVE' }],
      ['bizStep=inspecting', { finalized: false, bizStep: 'inspecting' }],
      ['disposition=in_progress', { finalized: false, disposition: 'in_progress' }],
      ['epc filter', { finalized: false, epc: EPC }],
      [
        'time range',
        {
          finalized: false,
          from: '2026-05-12T09:59:00.000Z',
          to: '2026-05-12T10:01:00.000Z',
        },
      ],
      [
        'readPoint=FunctionalTest',
        {
          finalized: false,
          readPoint: 'urn:acme:bike:station:FunctionalTest',
        },
      ],
      [
        'bizLocation=FunctionalTest',
        {
          finalized: false,
          bizLocation: 'urn:acme:bike:station:FunctionalTest',
        },
      ],
    ];

    for (const [label, params] of cases) {
      const result = await store.query(buildEpcisQuery(params, CG));
      expect(result.type, label).toBe('bindings');
      if (result.type !== 'bindings') continue;
      expect(result.bindings.map((row) => row['event']), label).toEqual([EVENT]);
    }
  });
});
