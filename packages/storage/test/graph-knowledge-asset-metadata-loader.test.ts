import { describe, expect, it, vi } from 'vitest';
import {
  buildGraphKnowledgeAssetMetadataQuery,
  parseDeterministicKnowledgeAssetUal,
} from '@origintrail-official/dkg-core';
import {
  lookupGraphScopedOrLegacyMetadata,
  resolveGraphScopedOrLegacyMetadata,
  type QueryResult,
  type TripleStore,
} from '../src/index.js';

const UAL = 'did:dkg:31337/0x1111111111111111111111111111111111111111/7';
const META = 'did:dkg:context-graph:test/_meta';

describe('tagged metadata lookup — failure provenance as data (W2 r1)', () => {
  it('reports a store-query rejection as query-failed with the ORIGINAL cause', async () => {
    const boom = new Error('scheduler busy');
    const store = {
      query: vi.fn(async (): Promise<QueryResult> => { throw boom; }),
    } as Pick<TripleStore, 'query'> as TripleStore;

    const lookup = await lookupGraphScopedOrLegacyMetadata(store, UAL, async () => null);

    expect(lookup).toEqual({ kind: 'query-failed', cause: boom });

    // And the throwing variant surfaces the SAME original object — existing
    // callers must be able to keep matching on the store error class.
    await expect(resolveGraphScopedOrLegacyMetadata(store, UAL, async () => null))
      .rejects.toBe(boom);
  });

  it('reports malformed V2 metadata as malformed, with the parser error as cause (review r2)', async () => {
    // A NON-EMPTY marker binding set with no contentScopeVersion: the parser
    // deterministically THROWS on it. The exact discriminant matters — a
    // catch that classified this as resolved/absent would silently turn data
    // corruption into “not held here” and the ingest would drop the event.
    const store = {
      query: vi.fn(async (): Promise<QueryResult> => ({
        type: 'bindings',
        bindings: [{ g: META } as never],
      })),
    } as Pick<TripleStore, 'query'> as TripleStore;

    const lookup = await lookupGraphScopedOrLegacyMetadata(store, UAL, async () => null);

    expect(lookup.kind).toBe('malformed');
    const cause = (lookup as { cause: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(/contentScopeVersion/);

    // And the throwing variant surfaces the parser error (a fresh lookup, so
    // message equality is the honest assertion — object identity is pinned by
    // the query-failed row, whose cause is a caller-held singleton).
    await expect(resolveGraphScopedOrLegacyMetadata(store, UAL, async () => null))
      .rejects.toThrow(/contentScopeVersion/);
  });

  it('does not classify a legacy-reader rejection — it belongs to the caller', async () => {
    const legacyBoom = new Error('legacy reader exploded');
    const store = {
      query: vi.fn(async (): Promise<QueryResult> => ({ type: 'bindings', bindings: [] })),
    } as Pick<TripleStore, 'query'> as TripleStore;

    await expect(
      lookupGraphScopedOrLegacyMetadata(store, UAL, async () => { throw legacyBoom; }),
    ).rejects.toBe(legacyBoom);
  });
});
describe('graph-scoped-first metadata resolution', () => {
  it('loads graph-scoped metadata before invoking the legacy fallback', async () => {
    const order: string[] = [];
    const store = {
      query: vi.fn(async (): Promise<QueryResult> => {
        order.push('graph');
        return { type: 'bindings', bindings: [] };
      }),
    } as Pick<TripleStore, 'query'> as TripleStore;
    const loadLegacy = vi.fn(async () => {
      order.push('legacy');
      return { rootEntity: 'urn:legacy:root' };
    });

    const result = await resolveGraphScopedOrLegacyMetadata(
      store,
      UAL,
      loadLegacy,
    );

    expect(order).toEqual(['graph', 'legacy']);
    expect(result).toEqual({
      kind: 'legacy',
      metadata: { rootEntity: 'urn:legacy:root' },
    });
  });

  it('canonicalizes a bare non-canonical UAL before the V2 marker lookup', async () => {
    // A leading-zero KA number (like a checksum-cased address) is a valid but
    // non-canonical alias of the same asset. V2 markers are stored under the
    // canonical form, so the marker lookup MUST query the canonical UAL — else
    // the alias misses its own marker and falls through to the legacy reader,
    // serving quarantined legacy rows / the private bag under the legacy access
    // policy. Regression: this fails if the raw input is queried verbatim.
    const ALIAS_UAL = 'did:dkg:31337/0x1111111111111111111111111111111111111111/007';
    const canonicalUal = parseDeterministicKnowledgeAssetUal(ALIAS_UAL).ual;
    expect(canonicalUal).toBe(UAL); // /007 normalizes to /7

    const captured: string[] = [];
    const store = {
      query: vi.fn(async (q: string): Promise<QueryResult> => {
        captured.push(q);
        return { type: 'bindings', bindings: [] };
      }),
    } as Pick<TripleStore, 'query'> as TripleStore;
    const loadLegacy = vi.fn(async () => null);

    await resolveGraphScopedOrLegacyMetadata(store, ALIAS_UAL, loadLegacy);

    expect(captured[0]).toBe(buildGraphKnowledgeAssetMetadataQuery(canonicalUal));
    expect(captured[0]).not.toContain('/007'); // never queried the raw alias
  });

  it('fails closed on an incomplete V2 marker without invoking legacy lookup', async () => {
    const store = {
      query: vi.fn(async (): Promise<QueryResult> => ({
        type: 'bindings',
        bindings: [
          {
            g: META,
            predicate: 'http://dkg.io/ontology/contentScopeVersion',
            value: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
          },
          {
            g: META,
            predicate: 'http://dkg.io/ontology/contextGraph',
            value: 'did:dkg:context-graph:test',
          },
        ],
      })),
    } as Pick<TripleStore, 'query'> as TripleStore;
    const loadLegacy = vi.fn(async () => ({ rootEntity: 'must-not-load' }));

    await expect(resolveGraphScopedOrLegacyMetadata(store, UAL, loadLegacy))
      .rejects.toThrow(/missing kaUal metadata/);
    expect(loadLegacy).not.toHaveBeenCalled();
  });
});
