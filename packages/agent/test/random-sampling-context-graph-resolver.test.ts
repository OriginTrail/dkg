import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  DKG_ONTOLOGY,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
import { ContextGraphRegistryMethods } from '../src/dkg-agent-cg-registry.js';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';

type SubscriptionRecord = {
  subscribed?: boolean;
  onChainHash?: string;
};

interface ResolverHost {
  store: OxigraphStore;
  config: { syncContextGraphs: string[] };
  chain: {
    getContextGraphNameHash(
      onChainContextGraphId: bigint,
      options?: { signal?: AbortSignal },
    ): Promise<string | null>;
  };
  subscribedContextGraphs: Map<string, SubscriptionRecord>;
  contextGraphBindingState: ContextGraphBindingState;
  contextGraphMetaProjection: ContextGraphMetaProjection;
  resolveLocalCgIdByOnChainId(onChainContextGraphId: bigint): string | null;
  isWireIdKeyedSubscription(localContextGraphId: string): boolean;
  readLiveOnChainAccessPolicy(
    onChainId: string,
    opCtx?: OperationContext,
    options?: { signal?: AbortSignal },
  ): Promise<0 | 1 | null>;
}

interface ResolverFixtureOptions {
  configuredContextGraphIds?: string[];
  subscriptions?: Map<string, SubscriptionRecord>;
  committedNameHash?: string;
  accessPolicy?: 0 | 1 | null;
  wireIds?: Set<string>;
  readLiveOnChainAccessPolicy?: ResolverHost['readLiveOnChainAccessPolicy'];
}

const stores: OxigraphStore[] = [];

function createResolverFixture(options: ResolverFixtureOptions = {}): ResolverHost {
  const store = new OxigraphStore();
  stores.push(store);
  const committedNameHash = options.committedNameHash
    ?? ethers.keccak256(ethers.toUtf8Bytes('default-context-graph'));
  return {
    store,
    config: { syncContextGraphs: options.configuredContextGraphIds ?? [] },
    chain: {
      getContextGraphNameHash: vi.fn(async () => committedNameHash),
    },
    subscribedContextGraphs: options.subscriptions ?? new Map(),
    contextGraphBindingState: new ContextGraphBindingState(),
    contextGraphMetaProjection: new ContextGraphMetaProjection(store),
    resolveLocalCgIdByOnChainId: vi.fn(() => null),
    isWireIdKeyedSubscription: (localContextGraphId) =>
      options.wireIds?.has(localContextGraphId) === true,
    readLiveOnChainAccessPolicy: options.readLiveOnChainAccessPolicy
      ?? vi.fn(async () => options.accessPolicy === undefined ? 0 : options.accessPolicy),
  };
}

function resolveColdBinding(
  host: ResolverHost,
  onChainContextGraphId: bigint,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return Reflect.apply(
    ContextGraphRegistryMethods.prototype.resolveRandomSamplingLocalContextGraphId,
    host,
    [onChainContextGraphId, signal],
  );
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe('Random Sampling Context Graph resolver', () => {
  it('recovers a cold public binding from the durable ontology index', async () => {
    const localContextGraphId =
      '0x9Eb3a49f91670f6b8EFC138Df0003F0ae0A23Dd0/cold-public-proof-cg';
    const host = createResolverFixture({
      committedNameHash: ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId)),
    });
    await host.store.insert([{
      subject: `did:dkg:context-graph:${localContextGraphId}`,
      predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
      object: '"317"',
      graph: 'did:dkg:context-graph:ontology',
    }]);

    await expect(resolveColdBinding(host, 317n)).resolves.toBe(localContextGraphId);
    expect(host.chain.getContextGraphNameHash).toHaveBeenCalledWith(317n, undefined);
    expect(host.readLiveOnChainAccessPolicy).toHaveBeenCalledWith(
      '317',
      expect.anything(),
      { signal: undefined },
    );
  });

  it('discovers a standard wallet/slug declaration when the durable binding is absent', async () => {
    const localContextGraphId =
      '0x9Eb3a49f91670f6b8EFC138Df0003F0ae0A23Dd0/cold-public-proof-cg';
    const host = createResolverFixture({
      committedNameHash: ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId)),
    });
    await host.store.insert([{
      subject: `did:dkg:context-graph:${localContextGraphId}`,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: `did:dkg:context-graph:${localContextGraphId}/_meta`,
    }]);

    await expect(resolveColdBinding(host, 380n)).resolves.toBe(localContextGraphId);
  });

  it('does not infer a private binding without an active local subscription', async () => {
    const localContextGraphId = 'cold-private-proof-cg';
    const host = createResolverFixture({
      configuredContextGraphIds: [localContextGraphId],
      committedNameHash: ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId)),
      accessPolicy: 1,
    });

    await expect(resolveColdBinding(host, 318n)).resolves.toBeUndefined();
  });

  it('rejects a stale local name whose commitment differs from the challenged slot', async () => {
    const host = createResolverFixture({
      configuredContextGraphIds: ['stale-local-name'],
      committedNameHash: ethers.keccak256(ethers.toUtf8Bytes('different-live-name')),
    });

    await expect(resolveColdBinding(host, 319n)).resolves.toBeUndefined();
    expect(host.readLiveOnChainAccessPolicy).not.toHaveBeenCalled();
  });

  it('does not treat a persisted onChainHash as cleartext identity evidence', async () => {
    const localContextGraphId = 'stale-cleartext-name';
    const liveCommitment = ethers.keccak256(ethers.toUtf8Bytes('different-live-name'));
    const host = createResolverFixture({
      committedNameHash: liveCommitment,
      subscriptions: new Map([[
        localContextGraphId,
        { subscribed: true, onChainHash: liveCommitment },
      ]]),
    });

    await expect(resolveColdBinding(host, 381n)).resolves.toBeUndefined();
    expect(host.readLiveOnChainAccessPolicy).not.toHaveBeenCalled();
  });

  it('accepts a host-only hash key only when subscription metadata proves wire-keying', async () => {
    const committedNameHash = ethers.keccak256(ethers.toUtf8Bytes('host-only-graph'));
    const host = createResolverFixture({
      committedNameHash,
      subscriptions: new Map([[
        committedNameHash,
        { subscribed: true, onChainHash: committedNameHash },
      ]]),
      wireIds: new Set([committedNameHash]),
    });

    await expect(resolveColdBinding(host, 384n)).resolves.toBe(committedNameHash);
  });

  it('fails closed when live policy and liveness cannot be attested', async () => {
    const localContextGraphId = 'inactive-public-proof-cg';
    const host = createResolverFixture({
      configuredContextGraphIds: [localContextGraphId],
      committedNameHash: ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId)),
      accessPolicy: null,
    });

    await expect(resolveColdBinding(host, 382n)).resolves.toBeUndefined();
  });

  it('invalidates a cached curated binding when its subscription is revoked', async () => {
    const localContextGraphId = 'curated-proof-cg';
    const subscription = { subscribed: true };
    const readLiveOnChainAccessPolicy = vi.fn(async () => 1 as const);
    const host = createResolverFixture({
      committedNameHash: ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId)),
      subscriptions: new Map([[localContextGraphId, subscription]]),
      readLiveOnChainAccessPolicy,
    });

    await expect(resolveColdBinding(host, 385n)).resolves.toBe(localContextGraphId);
    subscription.subscribed = false;
    await expect(resolveColdBinding(host, 385n)).resolves.toBeUndefined();
    expect(readLiveOnChainAccessPolicy).toHaveBeenCalledTimes(2);
  });

  it('re-attests a positive cached binding after its bounded TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00Z'));
    const localContextGraphId = 'ttl-public-proof-cg';
    const host = createResolverFixture({
      configuredContextGraphIds: [localContextGraphId],
      committedNameHash: ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId)),
    });

    await expect(resolveColdBinding(host, 386n)).resolves.toBe(localContextGraphId);
    await expect(resolveColdBinding(host, 386n)).resolves.toBe(localContextGraphId);
    expect(host.chain.getContextGraphNameHash).toHaveBeenCalledTimes(1);
    expect(host.readLiveOnChainAccessPolicy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    await expect(resolveColdBinding(host, 386n)).resolves.toBe(localContextGraphId);
    expect(host.chain.getContextGraphNameHash).toHaveBeenCalledTimes(2);
    expect(host.readLiveOnChainAccessPolicy).toHaveBeenCalledTimes(2);
  });

  it('physically settles when a final policy attestation ignores cancellation', async () => {
    const localContextGraphId = 'stalled-policy-proof-cg';
    let observedSignal: AbortSignal | undefined;
    const readLiveOnChainAccessPolicy: ResolverHost['readLiveOnChainAccessPolicy'] = vi.fn(
      async (_onChainId, _opCtx, options) => {
        observedSignal = options?.signal;
        return new Promise<never>(() => undefined);
      },
    );
    const host = createResolverFixture({
      configuredContextGraphIds: [localContextGraphId],
      committedNameHash: ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId)),
      readLiveOnChainAccessPolicy,
    });
    const controller = new AbortController();
    const resolution = resolveColdBinding(host, 383n, controller.signal);
    await vi.waitFor(() => expect(readLiveOnChainAccessPolicy).toHaveBeenCalledOnce());

    controller.abort(new Error('proof deadline elapsed'));
    await expect(resolution).rejects.toThrow('proof deadline elapsed');
    expect(observedSignal).toBe(controller.signal);
    expect(observedSignal?.aborted).toBe(true);
  });
});
