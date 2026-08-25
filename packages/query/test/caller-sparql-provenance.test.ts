import { describe, expect, it } from 'vitest';
import {
  CALLER_SPARQL_REJECTED_CODE,
  CallerSparqlRejectedError,
  isCallerSparqlRejectedError,
} from '../src/caller-sparql-error.js';

// GH#1758 / PR #2330 review — a store 400 is only a CLIENT error when it came
// from executing caller-supplied SPARQL. The same request also runs
// engine-generated queries (access control, graph resolution, metadata scans),
// and a backend rejecting one of those is an integration fault. This contract
// is what lets the HTTP boundary tell the two apart.
describe('CallerSparqlRejectedError contract (GH#1758)', () => {
  it('carries the discriminant and the upstream status', () => {
    const e = new CallerSparqlRejectedError('SPARQL HTTP query failed (400): bad', 400);
    expect(e.code).toBe(CALLER_SPARQL_REJECTED_CODE);
    expect(e.status).toBe(400);
    expect(e).toBeInstanceOf(Error);
    expect(isCallerSparqlRejectedError(e)).toBe(true);
  });

  it('preserves the original error as cause for diagnosis', () => {
    const cause = new Error('SPARQL HTTP query failed (400): error at 1:15');
    const e = new CallerSparqlRejectedError(cause.message, 400, { cause });
    expect((e as { cause?: unknown }).cause).toBe(cause);
    // The rendered message is unchanged, so log greps keep working.
    expect(e.message).toBe(cause.message);
  });

  it('recognises a structurally-complete marker across a realm boundary', () => {
    // The daemon route checks this shape without importing the class.
    expect(isCallerSparqlRejectedError(
      Object.assign(new Error('x'), { code: CALLER_SPARQL_REJECTED_CODE, status: 422 }),
    )).toBe(true);
  });

  it('rejects partial or wrong shapes', () => {
    expect(isCallerSparqlRejectedError({ code: CALLER_SPARQL_REJECTED_CODE })).toBe(false);
    expect(isCallerSparqlRejectedError({ code: 'SOMETHING_ELSE', status: 400, message: 'x' })).toBe(false);
    expect(isCallerSparqlRejectedError(new Error('plain'))).toBe(false);
    expect(isCallerSparqlRejectedError(null)).toBe(false);
    expect(isCallerSparqlRejectedError(undefined)).toBe(false);
  });

  // NOTE: the 400/422 gate is a property of the ENGINE, not of this class, so
  // it is asserted in the wiring suite below against a real store rejection.
  // Asserting it on a hand-constructed instance here would be tautological
  // (PR #2330 review).
});

// ── The WIRING, not just the contract ──────────────────────────────────────
//
// A mutation check showed the contract test above and the route's
// classification test both stay green if the engine stops marking the caller
// query — each verifies a piece, neither verifies the seam. This drives a real
// DKGQueryEngine against a store that rejects with a typed 400 and asserts the
// engine translates it, which is the behaviour /api/query depends on.
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { SparqlHttpResponseError } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

describe('DKGQueryEngine marks caller-query rejections (GH#1758 wiring)', () => {
  class RejectingStore extends OxigraphStore {
    rejectMatching: RegExp | null = null;
    rejectStatus = 400;
    /** How many times a rejection actually fired — so a test cannot silently
     *  pass without exercising the path it claims to cover. */
    rejections = 0;
    override async query(sparql: string, options?: any): Promise<any> {
      if (this.rejectMatching && this.rejectMatching.test(sparql)) {
        this.rejections += 1;
        throw new SparqlHttpResponseError('query', this.rejectStatus, 'error at 1:15: expected one of REDUCED');
      }
      return super.query(sparql, options);
    }
  }

  it('translates a store 400 on the CALLER query into the marked error', async () => {
    const store = new RejectingStore();
    const engine = new DKGQueryEngine(store);
    // Only the caller's own SELECT is rejected.
    store.rejectMatching = /CALLER_MARKER/;

    let failure: unknown;
    try {
      await engine.query('SELECT ?s WHERE { ?s ?p ?o . # CALLER_MARKER\n }');
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeDefined();
    expect(isCallerSparqlRejectedError(failure)).toBe(true);
    expect((failure as CallerSparqlRejectedError).status).toBe(400);
    // The original is preserved for diagnosis.
    expect((failure as { cause?: unknown }).cause).toBeInstanceOf(SparqlHttpResponseError);
  });

  it('propagates a NON-malformed status unmarked, even from the caller query', () => {
    // The gate is 400/422 only. 401/403/404/429 and 5xx mean the store rejected
    // US and must stay server faults (PR #2330 review — the previous assertion
    // was tautological and would have passed if the engine translated these).
    for (const status of [401, 403, 404, 429, 500, 503]) {
      const store = new RejectingStore();
      store.rejectMatching = /CALLER_MARKER/;
      store.rejectStatus = status;
      const engine = new DKGQueryEngine(store);

      let failure: unknown;
      return engine
        .query('SELECT ?s WHERE { ?s ?p ?o . # CALLER_MARKER\n }')
        .then(
          () => { throw new Error(`expected a rejection for status ${status}`); },
          (err) => { failure = err; },
        )
        .then(() => {
          expect(failure).toBeInstanceOf(SparqlHttpResponseError);
          expect(isCallerSparqlRejectedError(failure)).toBe(false);
          expect((failure as SparqlHttpResponseError).status).toBe(status);
        });
    }
  });

  it('does NOT mark an ENGINE-generated query rejection, and the rejection really happens', () => {
    // PR #2330 review — the previous version allowed the query to SUCCEED, so
    // it could pass without the path under test ever running. `view:
    // 'working-memory'` makes the engine issue its own `_meta` sub-graph
    // lookup (`SELECT ?name WHERE { GRAPH <…/_meta> { ?subGraph a … } }`),
    // which the caller never wrote. Rejecting THAT must not be blamed on them.
    const store = new RejectingStore();
    store.rejectMatching = /\?subGraph a/;
    const engine = new DKGQueryEngine(store);

    return engine
      .query('SELECT ?s WHERE { ?s ?p ?o }', {
        contextGraphId: 'cg-1',
        view: 'working-memory',
        agentAddress: `0x${'1'.repeat(40)}`,
      })
      .then(
        () => { throw new Error('expected the engine-generated query to reject'); },
        (err) => {
          expect(store.rejections).toBeGreaterThan(0);
          expect(isCallerSparqlRejectedError(err)).toBe(false);
          expect(err).toBeInstanceOf(SparqlHttpResponseError);
        },
      );
  });

  it('marks the includeSharedMemory branch too, which used to bypass the helper', async () => {
    // PR #2330 review — `includeSharedMemory` executes two graph-wrapped forms
    // of the CALLER's query directly, outside execAndNormalize, so malformed
    // SPARQL on that supported path still produced an unmarked error and the
    // original HTTP 500.
    for (const marker of ['data', 'sharedMemory']) {
      const store = new RejectingStore();
      // Reject only the data graph, or only the shared-memory graph.
      store.rejectMatching = marker === 'data' ? /GRAPH <[^>]*cg-1> / : /_shared_memory/;
      const engine = new DKGQueryEngine(store);

      let failure: unknown;
      try {
        await engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: 'cg-1',
          includeSharedMemory: true,
        });
      } catch (err) {
        failure = err;
      }

      expect(store.rejections, `${marker}: rejection never fired`).toBeGreaterThan(0);
      expect(isCallerSparqlRejectedError(failure), `${marker}: not marked`).toBe(true);
      expect((failure as CallerSparqlRejectedError).status).toBe(400);
    }
  });
});


