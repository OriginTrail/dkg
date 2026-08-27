import { describe, expect, it, vi } from 'vitest';
import {
  DKG_ONTOLOGY,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { buildAuthoritativePublicMetaAskQuery } from
  '../src/context-graph-public-meta-proof.js';
import { confirmContextGraphMetadataV1 } from
  '../src/context-graph-meta-confirmation.js';
import { resolveActivePublicContextGraphChainProof } from
  '../src/active-public-context-graph-chain-proof.js';
import {
  reconcileConfiguredContextGraphMetadataV1,
  type ConfiguredContextGraphMetadataReconciliationDependencies,
} from
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

function realConfirmMetadata(
  store: TripleStore,
): ConfiguredContextGraphMetadataReconciliationDependencies['confirmMetadata'] {
  return (contextGraphId, input, resolveActivePublicChainProof) =>
    confirmContextGraphMetadataV1({
      chain: {} as never,
      resolveActivePublicChainProof,
      isPrivateContextGraph: async () => false,
      localApprovedAgentByContextGraph: new Map(),
      peerId: '12D3KooWConfiguredMetadataReconciliation',
      store,
      subscriptions: new Map(),
    }, contextGraphId, input);
}

describe('configured Context Graph metadata reconciliation', () => {
  it('reuses one active-public proof for placeholder repair and confirmation', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'single-proof';
    const resolveActivePublicChainProof = vi.fn(async () => ({ state: 'public' } as const));
    const confirmMetadata = vi.fn(realConfirmMetadata(store));
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
      expect(confirmMetadata).toHaveBeenCalledWith(
        contextGraphId,
        { rejectUnregisteredPlaceholder: true },
        expect.any(Function),
      );
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
    const confirmMetadata = vi.fn(realConfirmMetadata(store));
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
    const resolvePolicyState = vi.fn(async () => {
      throw new Error('temporary RPC outage');
    });
    const confirmMetadata = vi.fn(realConfirmMetadata(store));
    try {
      const result = await reconcileConfiguredContextGraphMetadataV1({
        store,
        resolveActivePublicChainProof: (id, operationContext) =>
          resolveActivePublicContextGraphChainProof(
            resolvePolicyState,
            id,
            operationContext,
          ),
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
      expect(resolvePolicyState).toHaveBeenCalledTimes(1);
      expect(confirmMetadata).toHaveBeenCalledWith(
        contextGraphId,
        { rejectUnregisteredPlaceholder: true },
        expect.any(Function),
      );
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('quarantines a query-visible repair until a later durability flush succeeds', async () => {
    const baseStore = new OxigraphStore();
    const contextGraphId = 'public-meta-flush-failure';
    const flush = vi.fn()
      .mockRejectedValueOnce(new Error('ENOSPC during public metadata flush'))
      .mockRejectedValueOnce(new Error('ENOSPC during public metadata flush'))
      .mockResolvedValueOnce(undefined);
    const store = overrideStore(baseStore, { flush });
    const resolveActivePublicChainProof = vi.fn(async () => ({ state: 'public' } as const));
    const confirmMetadata = vi.fn(realConfirmMetadata(store));
    const isLocallyCurated = vi.fn(async () => false);
    const dependencies = {
      store,
      resolveActivePublicChainProof,
      isLocallyCurated,
      confirmMetadata,
    };
    try {
      const first = await reconcileConfiguredContextGraphMetadataV1(
        dependencies,
        contextGraphId,
      );

      expect(first).toEqual({
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

      const unrelatedResolve = vi.fn(async () => ({ state: 'public' } as const));
      await expect(confirmContextGraphMetadataV1({
        chain: {} as never,
        resolveActivePublicChainProof: unrelatedResolve,
        isPrivateContextGraph: async () => false,
        localApprovedAgentByContextGraph: new Map(),
        peerId: '12D3KooWDurabilityQuarantine',
        store,
        subscriptions: new Map(),
      }, contextGraphId)).resolves.toBe(false);
      expect(unrelatedResolve).not.toHaveBeenCalled();

      await expect(reconcileConfiguredContextGraphMetadataV1(
        dependencies,
        contextGraphId,
      )).resolves.toEqual({
        outcome: 'pending',
        reason: 'missing-metadata',
        diagnostic: {
          kind: 'public-metadata-repair-failed',
          detail: 'ENOSPC during public metadata flush',
        },
      });
      expect(flush).toHaveBeenCalledTimes(2);
      expect(resolveActivePublicChainProof).toHaveBeenCalledTimes(1);
      expect(confirmMetadata).not.toHaveBeenCalled();

      await expect(reconcileConfiguredContextGraphMetadataV1(
        dependencies,
        contextGraphId,
      )).resolves.toEqual({ outcome: 'authoritative' });
      expect(flush).toHaveBeenCalledTimes(3);
      expect(resolveActivePublicChainProof).toHaveBeenCalledTimes(1);
      expect(confirmMetadata).toHaveBeenCalledTimes(1);
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
