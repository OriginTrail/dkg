import { describe, expect, it, vi } from 'vitest';
import {
  DKG_ONTOLOGY,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { buildAuthoritativePublicMetaAskQuery } from
  '../src/context-graph-public-meta-proof.js';
import type { ConfirmContextGraphMetadataInput } from
  '../src/context-graph-meta-confirmation.js';
import { reconcileConfiguredContextGraphMetadataV1 } from
  '../src/configured-context-graph-metadata-reconciliation.js';

function overrideStore(
  store: TripleStore,
  overrides: Partial<TripleStore>,
): TripleStore {
  return new Proxy(store, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return Reflect.get(overrides, property);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function hasPublicProof(
  store: TripleStore,
  contextGraphId: string,
): Promise<boolean> {
  const result = await store.query(buildAuthoritativePublicMetaAskQuery(contextGraphId));
  return result.type === 'boolean' && result.value;
}

describe('configured Context Graph metadata reconciliation', () => {
  it('reuses one active-public proof for placeholder repair and confirmation', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'single-proof';
    const resolveActivePublicChainProof = vi.fn(async () => ({ state: 'public' } as const));
    const confirmMetadata = vi.fn(async (
      _id: string,
      input: ConfirmContextGraphMetadataInput,
    ) => (
      input.activePublicChainProof?.state === 'public'
      && hasPublicProof(store, contextGraphId)
    ));
    try {
      await store.insert([{
        subject: contextGraphDataGraphUri(contextGraphId),
        predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
        object: '"unregistered"',
        graph: contextGraphMetaGraphUri(contextGraphId),
      }]);

      const result = await reconcileConfiguredContextGraphMetadataV1({
        store,
        resolveActivePublicChainProof,
        isLocallyCurated: async () => false,
        confirmMetadata,
      }, contextGraphId);

      expect(result).toEqual({
        outcome: 'authoritative',
        diagnostic: { kind: 'public-metadata-projection-completed' },
      });
      expect(resolveActivePublicChainProof).toHaveBeenCalledTimes(1);
      expect(confirmMetadata).toHaveBeenCalledWith(contextGraphId, {
        rejectUnregisteredPlaceholder: true,
        activePublicChainProof: { state: 'public' },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('keeps negative and positive chain evidence typed through confirmation', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'typed-chain-evidence';
    const resolveActivePublicChainProof = vi.fn()
      .mockResolvedValueOnce({ state: 'not-public', reason: 'private' })
      .mockResolvedValueOnce({ state: 'public' });
    const confirmMetadata = vi.fn(async (
      _id: string,
      input: ConfirmContextGraphMetadataInput,
    ) => (
      input.activePublicChainProof?.state === 'public'
      && hasPublicProof(store, contextGraphId)
    ));
    try {
      const dependencies = {
        store,
        resolveActivePublicChainProof,
        isLocallyCurated: async () => false,
        confirmMetadata,
      };

      await expect(reconcileConfiguredContextGraphMetadataV1(
        dependencies,
        contextGraphId,
      )).resolves.toEqual({
        outcome: 'pending',
        reason: 'missing-metadata',
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);

      await expect(reconcileConfiguredContextGraphMetadataV1(
        dependencies,
        contextGraphId,
      )).resolves.toEqual({
        outcome: 'authoritative',
        diagnostic: { kind: 'public-metadata-projection-completed' },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(true);
      expect(resolveActivePublicChainProof).toHaveBeenCalledTimes(2);
    } finally {
      await store.close();
    }
  });

  it('preserves a resolver rejection as an unknown RPC chain proof', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'rpc-failure';
    const confirmMetadata = vi.fn(async () => false);
    try {
      const result = await reconcileConfiguredContextGraphMetadataV1({
        store,
        resolveActivePublicChainProof: async () => {
          throw new Error('temporary RPC outage');
        },
        isLocallyCurated: async () => false,
        confirmMetadata,
      }, contextGraphId);

      expect(result).toEqual({
        outcome: 'pending',
        reason: 'missing-metadata',
        diagnostic: {
          kind: 'public-chain-proof-unavailable',
          reason: 'rpc-failure',
          detail: 'temporary RPC outage',
        },
      });
      expect(confirmMetadata).toHaveBeenCalledWith(contextGraphId, {
        rejectUnregisteredPlaceholder: true,
        activePublicChainProof: {
          state: 'unknown',
          reason: 'rpc-failure',
          detail: 'temporary RPC outage',
        },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('fails closed when a repair is query-visible but its durability flush rejects', async () => {
    const baseStore = new OxigraphStore();
    const contextGraphId = 'public-meta-flush-failure';
    const flush = vi.fn(async () => {
      throw new Error('ENOSPC during public metadata flush');
    });
    const store = overrideStore(baseStore, { flush });
    const confirmMetadata = vi.fn(async () => hasPublicProof(store, contextGraphId));
    const isLocallyCurated = vi.fn(async () => false);
    try {
      const result = await reconcileConfiguredContextGraphMetadataV1({
        store,
        resolveActivePublicChainProof: async () => ({ state: 'public' }),
        isLocallyCurated,
        confirmMetadata,
      }, contextGraphId);

      expect(result).toEqual({
        outcome: 'pending',
        reason: 'missing-metadata',
        diagnostic: {
          kind: 'public-metadata-repair-failed',
          detail: 'ENOSPC during public metadata flush',
        },
      });
      expect(flush).toHaveBeenCalledTimes(1);
      expect(await hasPublicProof(store, contextGraphId)).toBe(true);
      expect(confirmMetadata).not.toHaveBeenCalled();
      expect(isLocallyCurated).not.toHaveBeenCalled();
    } finally {
      await baseStore.close();
    }
  });

  it('returns a repair diagnostic instead of throwing when the real atomic update rejects', async () => {
    const baseStore = new OxigraphStore();
    const contextGraphId = 'public-meta-update-failure';
    const update = vi.fn(async () => {
      throw new Error('SPARQL unavailable');
    });
    const store = overrideStore(baseStore, { update });
    const confirmMetadata = vi.fn(async () => true);
    try {
      await expect(reconcileConfiguredContextGraphMetadataV1({
        store,
        resolveActivePublicChainProof: async () => ({ state: 'public' }),
        isLocallyCurated: async () => false,
        confirmMetadata,
      }, contextGraphId)).resolves.toEqual({
        outcome: 'pending',
        reason: 'missing-metadata',
        diagnostic: {
          kind: 'public-metadata-repair-failed',
          detail: 'SPARQL unavailable',
        },
      });

      expect(update).toHaveBeenCalledTimes(1);
      expect(confirmMetadata).not.toHaveBeenCalled();
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await baseStore.close();
    }
  });

  it('may confirm independent authority after a failure known to precede mutation', async () => {
    const baseStore = new OxigraphStore();
    const contextGraphId = 'public-meta-pre-mutation-failure';
    const store = overrideStore(baseStore, { update: undefined });
    const confirmMetadata = vi.fn(async () => true);
    try {
      const result = await reconcileConfiguredContextGraphMetadataV1({
        store,
        resolveActivePublicChainProof: async () => ({ state: 'public' }),
        isLocallyCurated: async () => false,
        confirmMetadata,
      }, contextGraphId);

      expect(result).toEqual({
        outcome: 'authoritative',
        diagnostic: {
          kind: 'public-metadata-repair-failed',
          detail: 'Triple store does not support atomic public metadata repair',
        },
      });
      expect(confirmMetadata).toHaveBeenCalledTimes(1);
    } finally {
      await baseStore.close();
    }
  });
});
