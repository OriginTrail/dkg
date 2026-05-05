import { describe, expect, it } from 'vitest';
import type { Quad, QueryResult, TripleStore } from '@origintrail-official/dkg-storage';
import { resolveKcIdByRootEntity } from '../src/dkg-agent-utils.js';

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
});
