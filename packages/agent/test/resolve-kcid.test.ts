import { describe, expect, it } from 'vitest';
import type { Quad, QueryResult, TripleStore } from '@origintrail-official/dkg-storage';
import {
  AmbiguousRootEntityError,
  resolveKcIdByRootEntity,
} from '../src/dkg-agent-utils.js';

interface CapturedQuery {
  sparql: string;
}

function makeStore(
  resultByPattern: (sparql: string) => QueryResult,
): { store: TripleStore; calls: CapturedQuery[] } {
  const calls: CapturedQuery[] = [];
  // Tiny mock — we only exercise `query`, but TS demands the full interface.
  // The unused methods throw so any accidental dependency surfaces loudly.
  const store: TripleStore = {
    async query(sparql: string) {
      calls.push({ sparql });
      return resultByPattern(sparql);
    },
    async insert(_q: Quad[]): Promise<void> {
      throw new Error('insert: not implemented in mock');
    },
    async delete(_q: Quad[]): Promise<void> {
      throw new Error('delete: not implemented in mock');
    },
    async deleteByPattern(): Promise<number> {
      throw new Error('deleteByPattern: not implemented in mock');
    },
    async hasGraph(): Promise<boolean> {
      throw new Error('hasGraph: not implemented in mock');
    },
    async createGraph(): Promise<void> {
      throw new Error('createGraph: not implemented in mock');
    },
    async dropGraph(): Promise<void> {
      throw new Error('dropGraph: not implemented in mock');
    },
    async listGraphs(): Promise<string[]> {
      throw new Error('listGraphs: not implemented in mock');
    },
    async deleteBySubjectPrefix(): Promise<number> {
      throw new Error('deleteBySubjectPrefix: not implemented in mock');
    },
    async countQuads(): Promise<number> {
      throw new Error('countQuads: not implemented in mock');
    },
    async close(): Promise<void> {
      throw new Error('close: not implemented in mock');
    },
  };
  return { store, calls };
}

const VALID_URI = `urn:dkg:kafka-endpoint:0xowner:${'a'.repeat(64)}`;

describe('resolveKcIdByRootEntity', () => {
  it('returns the bigint kcId when the meta graph has a matching KA → KC → batchId chain', async () => {
    const { store, calls } = makeStore(() => ({
      type: 'bindings',
      bindings: [{ batchId: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
    }));

    const kcId = await resolveKcIdByRootEntity(store, 'devnet-test', VALID_URI);

    expect(kcId).toBe(42n);
    expect(calls).toHaveLength(1);
    // The query MUST target the CG's _meta graph explicitly — agent.query
    // would auto-wrap with the CG's data graph URI, which doesn't carry the
    // batchId chain.
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:devnet-test/_meta>');
    expect(calls[0].sparql).toContain(`<${VALID_URI}>`);
    expect(calls[0].sparql).toContain('rootEntity');
    expect(calls[0].sparql).toContain('partOf');
    expect(calls[0].sparql).toContain('batchId');
  });

  it('handles the SPARQL-JSON binding shape ({ value, type, datatype })', async () => {
    const { store } = makeStore(() => ({
      type: 'bindings',
      bindings: [{
        batchId: {
          value: '7',
          type: 'literal',
          datatype: 'http://www.w3.org/2001/XMLSchema#integer',
        } as unknown as string,
      }],
    }));

    const kcId = await resolveKcIdByRootEntity(store, 'devnet-test', VALID_URI);
    expect(kcId).toBe(7n);
  });

  it('returns null when no KA matches the root entity in the requested CG', async () => {
    const { store } = makeStore(() => ({ type: 'bindings', bindings: [] }));
    const kcId = await resolveKcIdByRootEntity(store, 'devnet-test', VALID_URI);
    expect(kcId).toBeNull();
  });

  it('returns null when the binding row is missing the batchId variable', async () => {
    const { store } = makeStore(() => ({
      type: 'bindings',
      bindings: [{} as Record<string, string>],
    }));
    const kcId = await resolveKcIdByRootEntity(store, 'devnet-test', VALID_URI);
    expect(kcId).toBeNull();
  });

  it('returns null when the batchId literal cannot be parsed as a bigint', async () => {
    // Defence-in-depth: a malformed meta graph (manual edit, schema bug, etc.)
    // shouldn't crash the caller — surface as "unresolvable" instead.
    const { store } = makeStore(() => ({
      type: 'bindings',
      bindings: [{ batchId: '"not-a-number"' }],
    }));
    const kcId = await resolveKcIdByRootEntity(store, 'devnet-test', VALID_URI);
    expect(kcId).toBeNull();
  });

  it('returns null on construct/ask query results (defensive — the SPARQL is SELECT)', async () => {
    const { store } = makeStore(() => ({
      type: 'boolean',
      value: true,
    }));
    const kcId = await resolveKcIdByRootEntity(store, 'devnet-test', VALID_URI);
    expect(kcId).toBeNull();
  });

  it('throws on a malformed contextGraphId (validateContextGraphId rejects unsafe chars)', async () => {
    const { store, calls } = makeStore(() => ({ type: 'bindings', bindings: [] }));
    await expect(
      resolveKcIdByRootEntity(store, 'cg with space', VALID_URI),
    ).rejects.toThrow(/invalid contextGraphId/i);
    // The validator must run before any SPARQL query is issued.
    expect(calls).toHaveLength(0);
  });

  it('throws on a SPARQL-IRI-breaking rootEntityUri (assertSafeIri rejects `>`)', async () => {
    const { store, calls } = makeStore(() => ({ type: 'bindings', bindings: [] }));
    await expect(
      resolveKcIdByRootEntity(
        store,
        'devnet-test',
        'urn:dkg:kafka-endpoint:foo:bar> } UNION { ?ka <p> ?o BIND(<x',
      ),
    ).rejects.toThrow(/unsafe.*iri/i);
    expect(calls).toHaveLength(0);
  });

  it('throws on a rootEntityUri with whitespace', async () => {
    const { store } = makeStore(() => ({ type: 'bindings', bindings: [] }));
    await expect(
      resolveKcIdByRootEntity(store, 'devnet-test', 'urn:dkg:foo bar'),
    ).rejects.toThrow();
  });

  it('Bug 2: throws AmbiguousRootEntityError when 2+ KCs match the same rootEntity URI', async () => {
    // V10's `publish()` can create duplicate KAs at new kcIds for the same
    // rootEntity URI. With `LIMIT 1` and no `ORDER BY` the helper used to
    // return whichever the store happened to enumerate first — semantically
    // nondeterministic, with `revoke`/`verify` silently mutating the wrong
    // collection. The fix is to fail closed: 2+ matches throws so the
    // operator must disambiguate explicitly (probably by pruning the stale
    // KC before retrying the lifecycle verb).
    const { store } = makeStore(() => ({
      type: 'bindings',
      bindings: [
        { batchId: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>' },
        { batchId: '"99"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      ],
    }));

    await expect(
      resolveKcIdByRootEntity(store, 'devnet-test', VALID_URI),
    ).rejects.toBeInstanceOf(AmbiguousRootEntityError);
  });

  it('Bug 2: AmbiguousRootEntityError message names the URI, the CG, and the count', async () => {
    // Operator-debugging contract: the error must give the human enough to
    // act on without grepping the daemon log. URI + CG + count is the
    // minimum.
    const { store } = makeStore(() => ({
      type: 'bindings',
      bindings: [
        { batchId: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' },
        { batchId: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' },
        { batchId: '"3"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      ],
    }));

    try {
      await resolveKcIdByRootEntity(store, 'devnet-test', VALID_URI);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousRootEntityError);
      const e = err as AmbiguousRootEntityError;
      expect(e.message).toContain(VALID_URI);
      expect(e.message).toContain('devnet-test');
      expect(e.message).toContain('3');
      // Typed-error fields for programmatic introspection (route adapter
      // can map to a 409 without parsing the message).
      expect(e.rootEntityUri).toBe(VALID_URI);
      expect(e.contextGraphId).toBe('devnet-test');
      expect(e.matchCount).toBe(3);
    }
  });

  it('Bug 2: still resolves cleanly when exactly one match is present (regression guard for the single-row path)', async () => {
    // The fix changes the SPARQL shape (drops LIMIT 1) and the result
    // discrimination (1 → resolve, 0 → null, 2+ → throw). Pin that the
    // common 1-match case still returns the kcId.
    const { store } = makeStore(() => ({
      type: 'bindings',
      bindings: [{ batchId: '"7"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
    }));

    const kcId = await resolveKcIdByRootEntity(store, 'devnet-test', VALID_URI);
    expect(kcId).toBe(7n);
  });
});
