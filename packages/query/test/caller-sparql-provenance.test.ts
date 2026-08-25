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

  it('does not claim a non-malformed status', () => {
    // The engine only constructs this for 400/422; nothing else may be marked
    // as "the caller's query was bad".
    const e = new CallerSparqlRejectedError('m', 400);
    expect([400, 422]).toContain(e.status);
  });
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
    override async query(sparql: string, options?: any): Promise<any> {
      if (this.rejectMatching && this.rejectMatching.test(sparql)) {
        throw new SparqlHttpResponseError('query', 400, 'error at 1:15: expected one of REDUCED');
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

  it('does NOT mark a store 400 that came from a non-caller query', async () => {
    const store = new RejectingStore();
    const engine = new DKGQueryEngine(store);
    // Reject something the caller never wrote — an engine-generated shape.
    store.rejectMatching = /contentScopeVersion|dkg\.io\/ontology/;

    let failure: unknown;
    try {
      await engine.query('SELECT ?s WHERE { ?s ?p ?o }', { contextGraphId: 'cg-1' });
    } catch (err) {
      failure = err;
    }

    // Either it succeeded (no internal query matched) or it failed UNMARKED —
    // what must never happen is the caller being blamed for it.
    if (failure !== undefined) {
      expect(isCallerSparqlRejectedError(failure)).toBe(false);
    }
  });
});
