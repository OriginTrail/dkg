import { describe, expect, it, vi } from 'vitest';
import {
  buildGraphKnowledgeAssetMetadataQuery,
  parseDeterministicKnowledgeAssetUal,
} from '@origintrail-official/dkg-core';
import {
  resolveGraphScopedOrLegacyMetadata,
  type QueryResult,
  type TripleStore,
} from '../src/index.js';

const UAL = 'did:dkg:31337/0x1111111111111111111111111111111111111111/7';
const META = 'did:dkg:context-graph:test/_meta';

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
