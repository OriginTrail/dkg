/**
 * packages/epcis — extra QA coverage.
 *
 * Findings covered (see .test-audit/BUGS_FOUND.md):
 *
 *   K-6  TEST-DEBT  `epcis-api.e2e.test.ts` wraps every `it` in a
 *                   `beforeEach(({skip}) => { if (!nodeReachable) skip(); })`
 *                   hook, so on any machine without a live devnet the entire
 *                   suite silently skips. This file replaces that gap with
 *                   a stub-based **contract test that ALWAYS runs**,
 *                   exercising the REAL production code paths:
 *                     - createValidator() + handleCapture() for capture
 *                     - buildEpcisQuery() + handleEventsQuery() for query
 *                     - toEpcisEvent() shape of the EPCISQueryDocument envelope
 *                   …against a small in-memory Publisher + QueryEngine that
 *                   implement the two DI boundaries defined in `src/types.ts`.
 *                   No mocks on the code under test.
 *
 * Per QA policy: no production-code edits.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { handleCapture, handleEventsQuery, EpcisQueryError, EpcisValidationError } from '../src/handlers.js';
import type { Publisher, QueryEngine, CaptureOptions, EPCISDocument } from '../src/types.js';
import {
  VALID_OBJECT_EVENT_DOC,
  VALID_TRANSFORMATION_EVENT_DOC,
  INVALID_DOC,
  EMPTY_EVENT_LIST_DOC,
} from './fixtures/bicycle-story.js';

const CONTEXT_GRAPH_ID = 'epcis-contract-test';
const BASE_PATH = '/api/epcis/events';

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E_PATH = resolve(HERE, 'epcis-api.e2e.test.ts');

// ─────────────────────────────────────────────────────────────────────────────
// In-memory DI implementations of Publisher + QueryEngine. These are the
// exact surfaces declared in src/types.ts; no production code is stubbed.
// ─────────────────────────────────────────────────────────────────────────────

interface Captured {
  ual: string;
  kcId: string;
  doc: EPCISDocument;
  opts?: CaptureOptions;
}

function inMemoryPublisher(store: Captured[]): Publisher {
  let nextId = 1;
  return {
    async publish(contextGraphId, content, opts) {
      const kcId = `kc-${nextId++}`;
      const ual = `did:dkg:test:${contextGraphId}/${kcId}`;
      store.push({ ual, kcId, doc: content as EPCISDocument, opts });
      return { ual, kcId, status: 'confirmed' };
    },
  };
}

/**
 * Tiny SPARQL-ish query engine: inspects the SPARQL text from buildEpcisQuery,
 * then returns bindings corresponding to stored events. We only need enough
 * behaviour to exercise the shape contract — filter correctness itself is
 * covered by query-builder.test.ts and events-query.test.ts.
 */
function inMemoryQueryEngine(store: Captured[]): QueryEngine & { lastSparql?: string } {
  const engine: QueryEngine & { lastSparql?: string } = {
    async query(sparql) {
      engine.lastSparql = sparql;
      const bindings: Record<string, string>[] = [];
      // The real buildEpcisQuery emits `{ ?event epcis:epcList "<epc>" }`
      // (NOT a FILTER) for the epc= param. Parse that so our fake engine
      // actually narrows results the way the daemon would.
      const epcListMatch = sparql.match(/\?event epcis:epcList "([^"]+)"/);
      const wantEpc = epcListMatch?.[1];
      for (const c of store) {
        const events = c.doc.epcisBody?.eventList ?? c.doc.eventList ?? [];
        for (const e of events) {
          if (wantEpc && !(e.epcList ?? []).includes(wantEpc)) continue;

          bindings.push({
            event: `urn:uuid:fixture-${bindings.length}`,
            eventType: `https://gs1.github.io/EPCIS/${String(e.type)}`,
            eventTime: String(e.eventTime ?? ''),
            action: String(e.action ?? ''),
            bizStep: String(e.bizStep ?? ''),
            disposition: String(e.disposition ?? ''),
            parentID: String((e as any).parentID ?? ''),
            readPoint: e.readPoint ? String(e.readPoint.id) : '',
            bizLocation: e.bizLocation ? String(e.bizLocation.id) : '',
            epcList: (e.epcList ?? []).join(', '),
            childEPCList: ((e as any).childEPCs ?? []).join(', '),
            inputEPCs: ((e as any).inputEPCList ?? []).join(', '),
            outputEPCs: ((e as any).outputEPCList ?? []).join(', '),
            ual: c.ual,
          });
        }
      }
      return { bindings };
    },
  };
  return engine;
}

// ─────────────────────────────────────────────────────────────────────────────
// K-6  e2e skip gap — static evidence
// ─────────────────────────────────────────────────────────────────────────────
describe('[K-6] e2e suite skip pattern exists (evidence this file is needed)', () => {
  it('epcis-api.e2e.test.ts still contains a beforeEach(..., skip()) hook', async () => {
    const src = await readFile(E2E_PATH, 'utf8');
    // Be tolerant of whitespace / destructuring style; only require that some
    // beforeEach somewhere in the file invokes skip().
    expect(src).toMatch(/beforeEach\(\s*\([^)]*skip[^)]*\)\s*=>/);
    expect(src).toMatch(/skip\(\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K-6  Contract test — always runs; exercises the full capture → query flow
// ─────────────────────────────────────────────────────────────────────────────
describe('[K-6] EPCIS capture → query contract (always runs, no devnet)', () => {
  const store: Captured[] = [];
  let publisher: Publisher;
  let engine: QueryEngine & { lastSparql?: string };

  beforeAll(() => {
    publisher = inMemoryPublisher(store);
    engine = inMemoryQueryEngine(store);
  });

  describe('Category A: capture happy path (mirrors e2e Category 3)', () => {
    it('ObjectEvent: validates, publishes, returns receipt', async () => {
      const result = await handleCapture(
        { epcisDocument: VALID_OBJECT_EVENT_DOC },
        { contextGraphId: CONTEXT_GRAPH_ID, publisher },
      );
      expect(result.status).toBe('confirmed');
      expect(result.eventCount).toBe(1);
      expect(result.ual).toMatch(/^did:dkg:test:/);
      expect(result.kcId).toMatch(/^kc-\d+$/);
      expect(() => new Date(result.receivedAt).toISOString()).not.toThrow();
    });

    it('TransformationEvent: validates and publishes', async () => {
      const result = await handleCapture(
        { epcisDocument: VALID_TRANSFORMATION_EVENT_DOC },
        { contextGraphId: CONTEXT_GRAPH_ID, publisher },
      );
      expect(result.status).toBe('confirmed');
      expect(result.eventCount).toBe(1);
    });

    it('publisher received exactly the submitted JSON-LD documents', () => {
      expect(store.length).toBeGreaterThanOrEqual(2);
      expect(store[0].doc).toBe(VALID_OBJECT_EVENT_DOC);
      expect(store[1].doc).toBe(VALID_TRANSFORMATION_EVENT_DOC);
    });
  });

  describe('Category B: capture validation boundaries (mirrors e2e Category 5)', () => {
    it('INVALID_DOC is rejected with EpcisValidationError', async () => {
      await expect(
        handleCapture(
          { epcisDocument: INVALID_DOC },
          { contextGraphId: CONTEXT_GRAPH_ID, publisher: inMemoryPublisher([]) },
        ),
      ).rejects.toBeInstanceOf(EpcisValidationError);
    });

    it('EMPTY_EVENT_LIST_DOC is rejected', async () => {
      await expect(
        handleCapture(
          { epcisDocument: EMPTY_EVENT_LIST_DOC },
          { contextGraphId: CONTEXT_GRAPH_ID, publisher: inMemoryPublisher([]) },
        ),
      ).rejects.toThrow(/validation failed/i);
    });

    it('publisher is not invoked when validation fails', async () => {
      const scratch: Captured[] = [];
      const p = inMemoryPublisher(scratch);
      // Pin to validation-shaped error vocabulary. `rejects.toBeDefined()`
      // passes for ANY rejection (even e.g. a bug where the publisher itself
      // crashed), hiding the case where validation silently ran and the
      // publisher call was what actually failed — we want to prove
      // validation rejected first.
      await expect(
        handleCapture(
          { epcisDocument: INVALID_DOC },
          { contextGraphId: CONTEXT_GRAPH_ID, publisher: p },
        ),
      ).rejects.toThrow(/validation|invalid|schema|epcis|document|missing|required/i);
      expect(scratch).toHaveLength(0);
    });
  });

  describe('Category C: capture with publishOptions (mirrors e2e Category 11)', () => {
    it('forwards accessPolicy + allowedPeers to Publisher', async () => {
      const scratch: Captured[] = [];
      const p = inMemoryPublisher(scratch);
      await handleCapture(
        {
          epcisDocument: VALID_OBJECT_EVENT_DOC,
          publishOptions: { accessPolicy: 'allowList', allowedPeers: ['12D3KooWPeerA'] },
        },
        { contextGraphId: CONTEXT_GRAPH_ID, publisher: p },
      );
      expect(scratch).toHaveLength(1);
      expect(scratch[0].opts).toEqual({
        accessPolicy: 'allowList',
        allowedPeers: ['12D3KooWPeerA'],
      });
    });
  });

  describe('Category D: query round-trip (mirrors e2e Category 4)', () => {
    it('returns an EPCISQueryDocument with correct shape', async () => {
      const { body } = await handleEventsQuery(
        new URLSearchParams(''),
        { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
      );
      expect(body.type).toBe('EPCISQueryDocument');
      expect(body.schemaVersion).toBe('2.0');
      expect(body['@context']).toEqual([
        'https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld',
        { dkg: 'http://dkg.io/ontology/' },
      ]);
      const events = body.epcisBody.queryResults.resultsBody.eventList;
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]).toMatchObject({ type: expect.any(String), 'dkg:ual': expect.any(String) });
    });

    it('?epc=… narrows to matching events (filter passes through SPARQL)', async () => {
      const { body } = await handleEventsQuery(
        new URLSearchParams('epc=urn:epc:id:sgtin:4012345.011111.1001'),
        { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
      );
      const events = body.epcisBody.queryResults.resultsBody.eventList;
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('ObjectEvent');
      expect(events[0].epcList).toEqual(['urn:epc:id:sgtin:4012345.011111.1001']);
      // Confirm the produced SPARQL references the context graph and the EPC.
      expect(engine.lastSparql).toContain('did:dkg:context-graph:epcis-contract-test');
      expect(engine.lastSparql).toContain('urn:epc:id:sgtin:4012345.011111.1001');
    });
  });

  describe('Category E: query parameter edge cases (mirrors e2e Category 7)', () => {
    it('invalid from/to range → EpcisQueryError(400)', async () => {
      await expect(
        handleEventsQuery(
          new URLSearchParams('from=2024-12-31T00:00:00Z&to=2024-01-01T00:00:00Z'),
          { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
        ),
      ).rejects.toMatchObject({ statusCode: 400, message: /date range/i });
    });

    it('EpcisQueryError is a real class (not just a tagged Error)', async () => {
      try {
        await handleEventsQuery(
          new URLSearchParams('from=2024-12-31T00:00:00Z&to=2024-01-01T00:00:00Z'),
          { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
        );
      } catch (err) {
        expect(err).toBeInstanceOf(EpcisQueryError);
        expect((err as EpcisQueryError).statusCode).toBe(400);
      }
    });
  });

  describe('Category F: pagination (mirrors e2e Link-header expectations)', () => {
    it('produces Link header when capture volume exceeds perPage', async () => {
      const many: Captured[] = [];
      const p = inMemoryPublisher(many);
      const eng = inMemoryQueryEngine(many);
      // Seed 12 captures of the valid object event so the engine returns 12 bindings.
      for (let i = 0; i < 12; i++) {
        await handleCapture(
          { epcisDocument: VALID_OBJECT_EVENT_DOC },
          { contextGraphId: CONTEXT_GRAPH_ID, publisher: p },
        );
      }
      const { body, headers } = await handleEventsQuery(
        new URLSearchParams('perPage=5'),
        { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: eng, basePath: BASE_PATH },
      );
      expect(body.epcisBody.queryResults.resultsBody.eventList).toHaveLength(5);
      expect(headers?.link).toBeDefined();
      expect(headers!.link).toMatch(/rel="next"/);
      expect(headers!.link).toContain(BASE_PATH);
      expect(headers!.link).toContain('nextPageToken=');
    });

    it('no Link header on last page', async () => {
      const few: Captured[] = [];
      const p = inMemoryPublisher(few);
      const eng = inMemoryQueryEngine(few);
      for (let i = 0; i < 3; i++) {
        await handleCapture(
          { epcisDocument: VALID_OBJECT_EVENT_DOC },
          { contextGraphId: CONTEXT_GRAPH_ID, publisher: p },
        );
      }
      const { body, headers } = await handleEventsQuery(
        new URLSearchParams('perPage=10'),
        { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: eng, basePath: BASE_PATH },
      );
      expect(body.epcisBody.queryResults.resultsBody.eventList).toHaveLength(3);
      expect(headers).toBeUndefined();
    });
  });

  describe('Category G: concurrent captures (mirrors e2e Category 14)', () => {
    it('handles 8 parallel captures without data corruption', async () => {
      const ccStore: Captured[] = [];
      const p = inMemoryPublisher(ccStore);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          handleCapture(
            { epcisDocument: VALID_OBJECT_EVENT_DOC },
            { contextGraphId: CONTEXT_GRAPH_ID, publisher: p },
          ),
        ),
      );
      expect(results).toHaveLength(8);
      const uals = new Set(results.map((r) => r.ual));
      expect(uals.size).toBe(8);
      expect(ccStore).toHaveLength(8);
    });
  });
});
