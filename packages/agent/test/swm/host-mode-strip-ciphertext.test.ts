/**
 * OT-RFC-49 WS-A — private-ciphertext strip (the irreversible host-mode strip).
 *
 * "Hosting follows access": with the `swmHostMode.stripCiphertext` flag ON
 * (the DEFAULT — `undefined` strips), a core custodies ZERO private SWM
 * ciphertext for CURATED context graphs. Random sampling now proves the public
 * `_catalog`, so the ciphertext lives member-side and members backfill from the
 * curator (REPLACE-recovery), never from a core. This file pins the five gated
 * entry points:
 *
 *   1. `reconcileSwmHostModeSubscription` — the primary subscribe choke point
 *      (declines, so neither `.meta` nor LU-11 chunk ingest is wired);
 *   2. `enableSwmHostModeFor` — the operator override hatch is CLOSED for
 *      curated CGs (WS-A divergence from rung-1, which left it open);
 *   3. `handleSwmHostCatchup` — the host-mode catch-up egress serves nothing;
 *   4. `handleGetCiphertextChunk` — the LU-11 chunk peer-serve (incl. the
 *      RFC-39 node-operator authority branch) serves nothing;
 *   5. `chooseFanOutTier` — a PRIVATE CG with an authoritative peer or agent
 *      roster drops the gossip leg so encrypted ciphertext never floods the
 *      public mesh.
 *
 * With the flag OFF (baseline), every path engages exactly as before — proving
 * the strip is gated and reversible via the kill-switch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '../../src/index.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';
import type { ContextGraphSub, ContextGraphSubInput, ContextGraphSubscriptionRecord } from '../../src/dkg-agent-types.js';
import {
  encodeGossipEnvelope,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
  type SubscriptionSource,
  SUBSCRIPTION_SOURCES,
} from '@origintrail-official/dkg-core';
import {
  chooseFanOutTier,
  type ChooseFanOutTierInput,
} from '../../src/swm/substrate-fanout.js';
import type { CGMemberEnumeration } from '../../src/swm/enumerate-cg-members.js';
import {
  decodeSwmHostCatchupResponse,
  encodeSwmHostCatchupRequest,
  SWM_HOST_CATCHUP_WIRE_VERSION,
} from '../../src/swm/host-catchup-wire.js';
import {
  decodeCiphertextChunkCatchupResponse,
} from '../../src/swm/ciphertext-chunk-catchup.js';

interface StripInternals {
  swmHostModeStore?: SwmHostModeStore;
  swmHostModeHandlers: Map<string, (topic: string, data: Uint8Array, from: string) => void>;
  swmHostModeSubscribed: Map<string, SubscriptionSource>;
  swmHostModeCurated: Map<string, boolean>;
  wireIdToLocalCgId: Map<string, string>;
  contextGraphBindingState: { capture(id: string): number };
  gossip: {
    subscribe(topic: string): void;
    unsubscribe(topic: string): void;
    offMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void): void;
    onMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void): void;
  };
  chain: MockChainAdapter;
  onChainAccessPolicyCache: Map<string, number>;
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  setContextGraphSubscription(id: string, row: ContextGraphSubInput, options: { persist: false }): ContextGraphSub;
  config: { swmHostMode?: { enabled?: boolean; stripCiphertext?: boolean; hostPublic?: boolean } };
  beacons: { lookupWireId(contextGraphId: string): { publisherAddress: string; curatorAddress: string; onChainContextGraphId?: string } | undefined };
  isPrivateContextGraph(cgId: string): Promise<boolean>;
  isConfirmedPublicForHostMode(cgId: string): Promise<boolean>;
  wireSwmHostModeHandler(cgId: string, source?: SubscriptionSource, curated?: boolean): boolean;
  reconcileSwmHostModeSubscription(cgId: string): Promise<void>;
  ingestSwmHostModeEnvelope(cgId: string, data: Uint8Array, from: string): Promise<void>;
  ingestSwmCiphertextChunkEnvelope(cgId: string, data: Uint8Array, from: string): Promise<void>;
  enableSwmHostModeFor(cgId: string): Promise<{
    subscribed: boolean; alreadySubscribed: boolean; hostingEnabled: boolean; memberMode?: boolean;
  }>;
  handleSwmHostCatchup(data: Uint8Array, fromPeerId: string): Promise<Uint8Array>;
  handleGetCiphertextChunk(data: Uint8Array, fromPeerId: string): Promise<Uint8Array>;
  initializeSwmHostModeStore(): Promise<void>;
  restoreSwmHostModeSubscriptions(): Promise<void>;
  stageOnChainContextGraphBindingFromNameHash(nameHash: string, onChainId: string): string | null;
  enqueueHostModePersistence(contextGraphId: string, subscribe: boolean): void;
  awaitHostModePersistence(contextGraphId: string): Promise<void>;
}

async function installCurated(core: DKGAgent, id: string): Promise<void> {
  const g = core as unknown as StripInternals;
  const hash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
  const registration = await g.chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1, nameHash: hash });
  g.subscribedContextGraphs.set(id, { subscribed: true, synced: true, syncMode: 'always-on', onChainHash: hash, onChainId: String(registration.contextGraphId) });
  g.onChainAccessPolicyCache.set(String(registration.contextGraphId), await g.chain.getContextGraphAccessPolicy(registration.contextGraphId));
}

function hostEnvelope(contextGraphId: string, chunked: boolean): Uint8Array {
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: chunked ? GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED : GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId,
    agentAddress: ethers.ZeroAddress,
    timestamp: String(Date.now()),
    signature: new Uint8Array(65),
    payload: new Uint8Array([1, 2, 3]),
    ...(chunked ? { swmMessageIndex: 0 } : {}),
  });
}

function installGossipStub(g: StripInternals): void {
  g.gossip = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    offMessage: vi.fn(),
    onMessage: vi.fn(),
  };
}

describe('OT-RFC-49 WS-A — host-mode private-ciphertext strip', () => {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.stop().catch(() => {}).then(() => a.store.close().catch(() => {}))));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** A core with a host-mode store installed. `strip` toggles the WS-A flag;
   * omit it to exercise the DEFAULT (strip ON). */
  async function makeCore(strip?: boolean, options: { chain?: MockChainAdapter; saved?: ContextGraphSubscriptionRecord } = {}): Promise<DKGAgent> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-strip-ct-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({
      name: 'StripCiphertextCore',
      chainAdapter: options.chain ?? new MockChainAdapter(),
      ...(options.saved ? { contextGraphSubscriptionRehydrationEnabled: false,
        contextGraphSubscriptionStore: { loadAll: async () => [{ ...options.saved! }], save: async () => {}, delete: async () => {} } } : {}),
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      rfc64CatalogActivation: { enabled: false },
      swmHostMode: strip === undefined ? { enabled: true } : { enabled: true, stripCiphertext: strip },
    });
    agents.push(core);
    if (options.saved) (core as unknown as { node: unknown }).node = { peerId: '12D3KooWStripPolicy', libp2p: { getPeers: () => [] } };
    installGossipStub(core as unknown as StripInternals);
    const store = new SwmHostModeStore({
      dataDir: join(dataDir, 'swm-host'),
      ...SwmHostModeStore.defaultLimits(),
    });
    await store.init();
    (core as unknown as StripInternals).swmHostModeStore = store;
    return core;
  }

  async function policyCore(policy: 0 | 1, strip?: boolean, cleartext = false) {
    const name = 'manual-strip-policy'; const hash = ethers.keccak256(ethers.toUtf8Bytes(name)).toLowerCase();
    const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 582n });
    await chain.createOnChainContextGraph({ accessPolicy: policy, publishPolicy: 1, nameHash: hash });
    const id = cleartext ? name : hash;
    const core = await makeCore(strip, { chain, saved: { id, subscribed: true, synced: true, syncScoped: true,
      onChainId: '582', onChainHash: hash } });
    await core.rehydrateContextGraphSubscriptions(null);
    const g = core as unknown as StripInternals;
    expect(g.subscribedContextGraphs.get(id)).toMatchObject({ subscribed: false, coreHosted: false, onChainId: '582' });
    expect(g.onChainAccessPolicyCache.has('582')).toBe(false);
    expect(await core.isPrivateContextGraph(id)).toBe(false);
    return { core, g, name, hash, id, chain };
  }

  // ── 1. reconcile subscribe-decline (primary choke point) ─────────────────

  it('default (no flag) DECLINES host-mode subscribe for a curated CG — strip is ON by default', async () => {
    const core = await makeCore(); // no stripCiphertext → undefined → ON
    const g = core as unknown as StripInternals;
    const cgId = 'cg-curated-default';
    await installCurated(core, cgId);
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); return true; };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([]);
    expect(g.swmHostModeHandlers.size).toBe(0);
  });

  it('strip ON DECLINES host-mode subscribe for a curated CG (no handler wired)', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-curated-stripped';
    await installCurated(core, cgId);
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); return true; };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([]);
    expect(g.swmHostModeHandlers.size).toBe(0);
  });

  it('hostPublic opt-in wires a confirmed public CG even while private strip is ON', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-public-core-tier';
    g.config.swmHostMode = { enabled: true, hostPublic: true, stripCiphertext: true };
    g.onChainAccessPolicyCache.set('2', 0);
    g.subscribedContextGraphs.set(cgId, { subscribed: false, synced: false, onChainId: '2' });
    g.isPrivateContextGraph = async () => false;
    g.isConfirmedPublicForHostMode = async () => true;
    expect(await (g as any).isCuratedForHostMode(cgId)).toBe(false);
    const wired: Array<{ id: string; curated?: boolean }> = [];
    g.wireSwmHostModeHandler = (id: string, _source?: SubscriptionSource, curated?: boolean) => {
      wired.push({ id, curated });
    };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([{ id: cgId, curated: false }]);
  });

  it('chain-event auto-host eligibility covers the full operator matrix', async () => {
    // Live observations, storage discovery and checkpoint restoration share
    // one owner. Drive its event path, not only its eligibility predicate.
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const eligible = (accessPolicy?: number, publishPolicy?: number): boolean =>
      (g as any).hostModeAutoHostEligible(accessPolicy, publishPolicy) as boolean;

    // Without the opt-in: only the curated tier auto-hosts.
    g.config.swmHostMode = { enabled: true, stripCiphertext: true };
    expect(eligible(1, 1)).toBe(true);
    expect(eligible(1, 0)).toBe(true);
    expect(eligible(0, 1)).toBe(false);
    expect(eligible(0, 0)).toBe(false);

    // With the opt-in: public AND open-publish joins it. accessPolicy 0 +
    // publishPolicy 0 is PCA — publicly readable but CURATED publish — and
    // stays OUT of the public host tier.
    g.config.swmHostMode = { enabled: true, hostPublic: true, stripCiphertext: true };
    expect(eligible(1, 1)).toBe(true);
    expect(eligible(1, 0)).toBe(true);
    expect(eligible(0, 1)).toBe(true);
    expect(eligible(0, 0)).toBe(false);
    // An event that carried no publishPolicy proves nothing about write
    // authority, so it is not the public tier either.
    expect(eligible(0, undefined)).toBe(false);
    expect(eligible(undefined, 1)).toBe(false);
    const reconcile = vi.spyOn(g, 'reconcileSwmHostModeSubscription').mockResolvedValue();
    let nextId = 100;
    for (const hostPublic of [false, true]) {
      g.config.swmHostMode = { enabled: true, hostPublic, stripCiphertext: true };
      for (const [accessPolicy, publishPolicy, expected] of [
        [0, 1, hostPublic], [0, 0, false], [1, 1, true],
      ] as const) {
        const onChainId = String(nextId++);
        const nameHash = ethers.keccak256(ethers.toUtf8Bytes(`observed-${onChainId}`)).toLowerCase();
        reconcile.mockClear();
        core.applyOnChainContextGraphObservation({ contextGraphId: onChainId,
          owner: ethers.ZeroAddress, nameHash, accessPolicy, publishPolicy,
          observedAtBlock: nextId }, { source: 'event' });
        expect(g.subscribedContextGraphs.get(nameHash)?.onChainId).toBe(onChainId);
        expect(g.onChainAccessPolicyCache.get(onChainId)).toBe(accessPolicy);
        if (expected) expect(reconcile).toHaveBeenCalledWith(nameHash, SUBSCRIPTION_SOURCES.CHAIN_EVENT);
        else expect(reconcile).not.toHaveBeenCalled();
      }
    }
    reconcile.mockRestore();
  });

  it('WITHOUT the hostPublic opt-in a confirmed public CG is NOT wired (dark by default)', async () => {
    // Codex review #2614 — every other test that reaches the non-curated admit
    // branch sets `hostPublic: true`, and the "default (no flag) DECLINES" case
    // uses a CURATED CG, so it is refused one branch earlier. Nothing pinned
    // the opt-in being off by default — the property the config doc promises.
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-public-no-opt-in';
    g.config.swmHostMode = { enabled: true, stripCiphertext: true }; // no hostPublic
    g.onChainAccessPolicyCache.set('2', 0);
    g.subscribedContextGraphs.set(cgId, { subscribed: false, synced: false, onChainId: '2' });
    g.isPrivateContextGraph = async () => false;
    const confirmed: string[] = [];
    g.isConfirmedPublicForHostMode = async (id: string) => { confirmed.push(id); return true; };
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); return true; };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([]);
    expect(g.swmHostModeHandlers.size).toBe(0);
    // The opt-in check returns BEFORE the chain probe — no RPC is spent on a
    // core that is not serving the public tier at all.
    expect(confirmed).toEqual([]);
  });

  it('hostPublic refuses an unconfirmed or restricted CG', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-public-policy-unknown';
    g.config.swmHostMode = { enabled: true, hostPublic: true, stripCiphertext: true };
    g.onChainAccessPolicyCache.set('2', 0);
    g.subscribedContextGraphs.set(cgId, { subscribed: false, synced: false, onChainId: '2' });
    g.isPrivateContextGraph = async () => false;
    g.isConfirmedPublicForHostMode = async () => false;
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); return true; };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([]);
    expect(g.swmHostModeHandlers.size).toBe(0);
  });

  it('cold restart restores a hash-only public host from its persisted chain binding', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-strip-ct-restore-public-'));
    tempDirs.push(dataDir);
    const wireId = ethers.keccak256(ethers.toUtf8Bytes('cg-public-cold-host')).toLowerCase();
    const onChainId = '42';

    const first = await DKGAgent.create({
      name: 'StripCiphertextFirstPublicCore',
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      rfc64CatalogActivation: { enabled: false },
      swmHostMode: { enabled: true, hostPublic: true, stripCiphertext: true },
    });
    const firstInternals = first as unknown as StripInternals;
    const firstStore = new SwmHostModeStore({
      dataDir: join(dataDir, 'swm-host'),
      ...SwmHostModeStore.defaultLimits(),
    });
    await firstStore.init();
    firstInternals.swmHostModeStore = firstStore;
    (firstInternals as any).scheduleRfc64CatalogResponsibilityReconciliationV1 = () => {};
    expect(firstInternals.stageOnChainContextGraphBindingFromNameHash(wireId, onChainId))
      .toBe(wireId);
    firstInternals.enqueueHostModePersistence(wireId, true);
    await firstInternals.awaitHostModePersistence(wireId);
    expect(await firstStore.listHostModeSubscriptions()).toEqual([{
      contextGraphId: wireId,
      onChainId,
    }]);
    await first.stop().catch(() => {});
    await first.store.close().catch(() => {});

    const chain = new MockChainAdapter();
    const getContextGraphAccessPolicy = vi.fn(async () => 0);
    const getContextGraphPublishPolicy = vi.fn(async () => ({
      publishPolicy: 1,
      publishAuthority: ethers.ZeroAddress,
    }));
    chain.getContextGraphAccessPolicy = getContextGraphAccessPolicy;
    chain.getContextGraphPublishPolicy = getContextGraphPublishPolicy;
    const restarted = await DKGAgent.create({
      name: 'StripCiphertextRestartedPublicCore',
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      chainAdapter: chain,
      rfc64CatalogActivation: { enabled: false },
      swmHostMode: { enabled: true, hostPublic: true, stripCiphertext: true },
    });
    agents.push(restarted);
    const restored = restarted as unknown as StripInternals;
    installGossipStub(restored);
    (restored as any).maybeMarkRegisteredForHostMode = async () => {};

    await restored.initializeSwmHostModeStore();
    await restored.restoreSwmHostModeSubscriptions();

    expect(restored.subscribedContextGraphs.get(wireId)?.onChainId).toBe(onChainId);
    expect(restored.swmHostModeSubscribed.has(wireId)).toBe(true);
    expect(restored.swmHostModeHandlers.has(wireId)).toBe(true);
    expect(getContextGraphAccessPolicy).toHaveBeenCalledWith(42n);
    expect(getContextGraphPublishPolicy).toHaveBeenCalledWith(42n);
  });

  it('restart restore contains a failing policy re-evaluation to keep startup alive', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-strip-ct-restore-policy-error-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({
      name: 'StripCiphertextRestorePolicyErrorCore',
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      rfc64CatalogActivation: { enabled: false },
      swmHostMode: { enabled: true, hostPublic: true, stripCiphertext: true },
    });
    agents.push(core);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-public-restore-error';
    const store = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await store.init();
    g.swmHostModeStore = store;
    await store.markHostModeSubscribed(cgId);
    g.reconcileSwmHostModeSubscription = async () => {
      throw new Error('simulated policy probe failure');
    };

    await expect(g.initializeSwmHostModeStore()).resolves.toBeUndefined();
    await expect(g.restoreSwmHostModeSubscriptions()).resolves.toBeUndefined();
  });

  it('strip OFF (baseline) WIRES host-mode subscribe for a curated CG', async () => {
    const core = await makeCore(false);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-curated-baseline';
    await installCurated(core, cgId);
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); return true; };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([cgId]);
  });

  it('restart restore wires persisted subscriptions when private-ciphertext strip is OFF', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-strip-ct-restore-legacy-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({
      name: 'StripCiphertextRestoreLegacyCore',
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      rfc64CatalogActivation: { enabled: false },
      swmHostMode: { enabled: true, stripCiphertext: false },
    });
    agents.push(core);
    const g = core as unknown as StripInternals;
    installGossipStub(g);
    const cgId = 'cg-curated-restore';
    const store = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await store.init();
    g.swmHostModeStore = store;
    await store.markHostModeSubscribed(cgId);
    (g as any).maybeMarkRegisteredForHostMode = async () => {};
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => {
      wired.push(id);
      return true;
    };

    await g.initializeSwmHostModeStore();
    await g.restoreSwmHostModeSubscriptions();

    expect(wired).toEqual([cgId]);
  });

  it('restart restore awaits at most reconcileBatchSize markers and drains the rest off startup', async () => {
    // Codex review #2614 — `initializeSwmHostModeStore` is awaited from
    // `start()`. Every persisted marker costs at least a store probe (and a
    // chain RPC pair on a `hostPublic` core), so the startup walk must be
    // capped the same way the periodic sweep is. Nothing may be dropped: the
    // tail still runs, just not on the boot path.
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-strip-ct-restore-batch-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({
      name: 'StripCiphertextRestoreBatchCore',
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      rfc64CatalogActivation: { enabled: false },
      swmHostMode: { enabled: true, stripCiphertext: false, reconcileBatchSize: 2 },
    });
    agents.push(core);
    const g = core as unknown as StripInternals;
    const store = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await store.init();
    g.swmHostModeStore = store;
    installGossipStub(g);
    const cgIds = ['cg-b1', 'cg-b2', 'cg-b3', 'cg-b4', 'cg-b5'];
    for (const cgId of cgIds) await store.markHostModeSubscribed(cgId);
    (g as any).maybeMarkRegisteredForHostMode = async () => {};
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => {
      wired.push(id);
      return true;
    };

    await g.initializeSwmHostModeStore();
    await g.restoreSwmHostModeSubscriptions();

    expect(wired).toHaveLength(2);
    expect(g.swmHostModeRestoreDrain).toBeDefined();

    await g.swmHostModeRestoreDrain;

    expect([...wired].sort()).toEqual([...cgIds].sort());
  });

  it('deferred restore drain skips a CG that became member-registered mid-drain', async () => {
    // Codex review #2614 follow-up — the batched restore above moved the tail
    // of the walk OFF the startup await, which broke the ordering the direct
    // (strip OFF) re-wire used to rely on: the whole walk finished inside the
    // awaited `initializeSwmHostModeStore`, i.e. before member-mode
    // rehydration could claim any CG. Now a marker past `reconcileBatchSize`
    // can be drained AFTER `reconcileSharedMemoryGossipSubscription` has
    // unwired the host handler and added the CG to
    // `sharedMemoryGossipRegistered` — re-wiring it there double-processes
    // every envelope (member apply + opaque host append). The refusal lives in
    // `wireSwmHostModeHandler` itself (review #2614), so this drives the REAL
    // wiring point instead of a stub of it.
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-strip-ct-restore-member-race-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({
      name: 'StripCiphertextRestoreMemberRaceCore',
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      rfc64CatalogActivation: { enabled: false },
      swmHostMode: { enabled: true, stripCiphertext: false, reconcileBatchSize: 2 },
    });
    agents.push(core);
    const g = core as unknown as StripInternals;
    const store = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await store.init();
    g.swmHostModeStore = store;
    const cgIds = ['cg-race-1', 'cg-race-2', 'cg-race-3', 'cg-race-4', 'cg-race-5'];
    for (const cgId of cgIds) await store.markHostModeSubscribed(cgId);
    installGossipStub(g);
    // Restore order is store-listing order, not the order they were marked.
    const restoreOrder = (await store.listHostModeSubscriptions()).map((e) => e.contextGraphId);
    expect([...restoreOrder].sort()).toEqual([...cgIds].sort());
    const firstDeferred = restoreOrder[2];
    const claimedByMember = restoreOrder[4];
    // `maybeMarkRegisteredForHostMode` runs right AFTER each marker is wired,
    // so it is the seam where member rehydration lands mid-drain: the first
    // deferred marker is done and the tail (including `claimedByMember`) has
    // not run yet.
    (g as any).maybeMarkRegisteredForHostMode = async (id: string) => {
      if (id === firstDeferred) g.sharedMemoryGossipRegistered.add(claimedByMember);
    };
    const hostKey = (id: string): string => (g as any).canonicalSwmHostModeKey(id) as string;

    await g.initializeSwmHostModeStore();
    await g.restoreSwmHostModeSubscriptions();

    expect([...g.swmHostModeSubscribed.keys()]).toEqual(restoreOrder.slice(0, 2).map(hostKey));
    expect(g.swmHostModeRestoreDrain).toBeDefined();

    await g.swmHostModeRestoreDrain;

    expect(g.swmHostModeHandlers.has(hostKey(claimedByMember))).toBe(false);
    expect(g.swmHostModeSubscribed.has(hostKey(claimedByMember))).toBe(false);
    expect([...g.swmHostModeSubscribed.keys()]).toEqual(restoreOrder.slice(0, 4).map(hostKey));
  });

  it('deferred restore drain refuses a HASH-keyed marker whose cleartext id is member-registered', async () => {
    // Codex review #2614 — `sharedMemoryGossipRegistered` is keyed by the
    // member's CLEARTEXT id, while a host-only discovery path persists its
    // marker under the curator-committed wire HASH. A raw `has()` misses that
    // pairing entirely, so the drain would wire a host handler onto the very
    // topic the member handler already owns (apply + opaque append). The
    // membership probe must resolve the hash back through `wireIdToLocalCgId`.
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-strip-ct-restore-hash-member-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({
      name: 'StripCiphertextRestoreHashMemberCore',
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      rfc64CatalogActivation: { enabled: false },
      swmHostMode: { enabled: true, stripCiphertext: false, reconcileBatchSize: 1 },
    });
    agents.push(core);
    const g = core as unknown as StripInternals;
    const store = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await store.init();
    g.swmHostModeStore = store;
    const cgId = 'cg-hash-keyed-member';
    const wireId = ethers.keccak256(ethers.toUtf8Bytes(cgId)).toLowerCase();
    // One inline marker keeps the hash marker in the DEFERRED tail.
    await store.markHostModeSubscribed('cg-hash-keyed-filler');
    await store.markHostModeSubscribed(wireId);
    installGossipStub(g);
    (g as any).maybeMarkRegisteredForHostMode = async () => {};
    // The node is a MEMBER of the same CG, registered under the cleartext id.
    g.wireIdToLocalCgId.set(wireId, cgId);
    g.sharedMemoryGossipRegistered.add(cgId);

    await g.initializeSwmHostModeStore();
    await g.restoreSwmHostModeSubscriptions();
    expect(g.swmHostModeRestoreDrain).toBeDefined();
    await g.swmHostModeRestoreDrain;

    expect(g.swmHostModeHandlers.has(wireId)).toBe(false);
    expect(g.swmHostModeSubscribed.has(wireId)).toBe(false);
    // The marker itself must SURVIVE: member mode can hand the CG back, and
    // the marker is what re-engages hosting then.
    expect((await store.listHostModeSubscriptions()).map((e) => e.contextGraphId))
      .toContain(wireId);
  });

  it('stop() fences the deferred restore drain — nothing is wired after teardown', async () => {
    // Codex review #2614 — the drain was a detached, unowned task: `stop()`
    // cleared the host-mode timers and joined every other background owner but
    // never this one, so the tail could still subscribe a gossip topic and
    // rewrite a marker while the node tore down.
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-strip-ct-restore-stop-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({
      name: 'StripCiphertextRestoreStopCore',
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      rfc64CatalogActivation: { enabled: false },
      swmHostMode: { enabled: true, stripCiphertext: false, reconcileBatchSize: 1 },
    });
    agents.push(core);
    const g = core as unknown as StripInternals;
    const store = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await store.init();
    g.swmHostModeStore = store;
    const cgIds = ['cg-stop-1', 'cg-stop-2', 'cg-stop-3', 'cg-stop-4'];
    for (const cgId of cgIds) await store.markHostModeSubscribed(cgId);
    installGossipStub(g);
    (g as any).maybeMarkRegisteredForHostMode = async () => {};

    await g.initializeSwmHostModeStore();
    await g.restoreSwmHostModeSubscriptions();

    expect(g.swmHostModeSubscribed.size).toBe(1);
    expect(g.swmHostModeRestoreDrain).toBeDefined();

    await core.stop();
    await g.swmHostModeRestoreDrain;

    // The drain aborted at its first fence check, before the unref'd tick's
    // first deferred marker could be wired.
    expect(g.swmHostModeSubscribed.size).toBe(1);
  });

  it('restart restore contains a failing legacy re-wire to keep startup alive', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-strip-ct-restore-legacy-error-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({
      name: 'StripCiphertextRestoreLegacyErrorCore',
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      rfc64CatalogActivation: { enabled: false },
      swmHostMode: { enabled: true, stripCiphertext: false },
    });
    agents.push(core);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-curated-restore-error';
    const store = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await store.init();
    g.swmHostModeStore = store;
    await store.markHostModeSubscribed(cgId);
    g.wireSwmHostModeHandler = () => {
      throw new Error('simulated re-wire failure');
    };

    await expect(g.initializeSwmHostModeStore()).resolves.toBeUndefined();
    await expect(g.restoreSwmHostModeSubscriptions()).resolves.toBeUndefined();
  });

  // ── 2. operator override hatch CLOSED (WS-A divergence from rung-1) ───────

  it('strip ON CLOSES the operator override `enableSwmHostModeFor` for a curated CG', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-operator-curated';
    g.isPrivateContextGraph = async () => true; // curated
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); return true; };

    const result = await g.enableSwmHostModeFor(cgId);

    expect(result).toEqual({ subscribed: false, alreadySubscribed: false, hostingEnabled: true });
    expect(wired).toEqual([]);
  });

  it('strip OFF (baseline) leaves the operator override OPEN for a curated CG', async () => {
    const core = await makeCore(false);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-operator-baseline';
    g.isPrivateContextGraph = async () => true; // curated
    const wired: string[] = [];
    const wire = g.wireSwmHostModeHandler.bind(core);
    vi.spyOn(core, 'wireSwmHostModeHandler').mockImplementation((id, source, curated) => {
      wired.push(id); wire(id, source, curated);
    });

    const result = await g.enableSwmHostModeFor(cgId);

    expect(result.subscribed).toBe(true);
    expect(wired).toEqual([cgId]);
  });

  it('strip ON CLOSES the operator hatch for a host-only core (curated via native numeric policy, NO local _meta)', async () => {
    // The WS-A target case: a core that learned of a curated CG via
    // chain-event/beacon has NO local `_meta`, so `isPrivateContextGraph`
    // returns false. The operator hatch must STILL refuse — it consults the
    // same native numeric policy probe (`onChainHash`) the auto-host path uses,
    // not `isPrivateContextGraph` alone.
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-host-only-core';
    await installCurated(core, cgId); // native private policy
    g.isPrivateContextGraph = async () => false;        // no local _meta
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); return true; };

    const result = await g.enableSwmHostModeFor(cgId);

    expect(result).toEqual({ subscribed: false, alreadySubscribed: false, hostingEnabled: true });
    expect(wired).toEqual([]);
  });

  it('strip ON CLOSES the operator hatch for a beacon-discovered CG (onChainHash + verified beacon)', async () => {
    // Curation probe source (b): a beacon-driven pre-reg auto-host has an
    // `onChainHash` but NO numeric binding and no local `_meta`. Curation is
    // proved by the VERIFIED beacon recorded for that wire id — after this PR
    // the bare `onChainHash` is no longer sufficient on its own, so this branch
    // is what keeps the hatch closed for the beacon topology.
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-beacon-host-only';
    const wireId = ethers.keccak256(ethers.toUtf8Bytes(cgId)).toLowerCase();
    g.subscribedContextGraphs.set(cgId, { subscribed: false, synced: false, onChainHash: wireId });
    g.isPrivateContextGraph = async () => false;        // no local _meta
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); return true; };

    // Without the beacon the CG reads as NOT curated, so the hatch stays open.
    expect(await (g as any).isCuratedForHostMode(cgId)).toBe(false);

    g.beaconCuratorByWireId.set(wireId, '0x' + '11'.repeat(20));

    expect(await (g as any).isCuratedForHostMode(cgId)).toBe(true);
    const result = await g.enableSwmHostModeFor(cgId);

    expect(result).toEqual({ subscribed: false, alreadySubscribed: false, hostingEnabled: true });
    expect(wired).toEqual([]);
  });

  it('strip ON CLOSES the operator hatch for a cold-restored chain binding it cannot clear', async () => {
    // Codex review #2614 — the curation probe answers from IN-MEMORY state
    // (`onChainAccessPolicyCache`, `beaconCuratorByWireId`) plus the local
    // `_meta`. Right after a restart on a host-only core all three are cold, so
    // a genuinely curated CG restored from its persisted marker reads NOT
    // curated. A local `false` must not authorize custody for a CG that carries
    // chain provenance: the chain-authoritative verdict decides, and an
    // unavailable/negative answer refuses.
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-cold-restored-curated';
    const wireId = ethers.keccak256(ethers.toUtf8Bytes(cgId)).toLowerCase();
    // Exactly the state `restorePersistedHostModeBinding` materialises from a
    // hash-keyed marker: an `onChainHash` + `onChainId` row, EMPTY policy cache,
    // no beacon, no local `_meta`.
    expect(g.stageOnChainContextGraphBindingFromNameHash(wireId, '7')).toBe(wireId);
    expect(g.onChainAccessPolicyCache.size).toBe(0);
    expect(g.beaconCuratorByWireId.size).toBe(0);
    g.isPrivateContextGraph = async () => false;         // host-only core: no _meta
    g.isConfirmedPublicForHostMode = async () => false;  // chain cannot clear it
    expect(await (g as any).isCuratedForHostMode(wireId)).toBe(false);
    installGossipStub(g);

    const result = await g.enableSwmHostModeFor(wireId);

    expect(result).toEqual({ subscribed: false, alreadySubscribed: false, hostingEnabled: true });
    expect(g.swmHostModeHandlers.size).toBe(0);
    expect(g.swmHostModeSubscribed.size).toBe(0);
  });

  it('strip ON admits an exact cold-restored public name and chain binding', async () => {
    const { g, name, hash, chain } = await policyCore(0, true, true);
    g.onChainAccessPolicyCache.set('582', await chain.getContextGraphAccessPolicy(582n));
    const result = await g.enableSwmHostModeFor(name);
    expect(result.subscribed).toBe(true);
    expect(g.swmHostModeCurated.get(hash)).toBe(false);
  });

  it('strip ON does NOT affect the operator override for a PUBLIC/uncurated CG', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-operator-public';
    const hash = ethers.keccak256(ethers.toUtf8Bytes(cgId)).toLowerCase();
    const registration = await g.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
    g.setContextGraphSubscription(cgId, { subscribed: false, synced: false, onChainId: String(registration.contextGraphId), onChainHash: hash }, { persist: false });
    g.onChainAccessPolicyCache.set(String(registration.contextGraphId), await g.chain.getContextGraphAccessPolicy(registration.contextGraphId));
    expect(await core.isPrivateContextGraph(cgId)).toBe(false);
    const wired: string[] = [];
    const wire = g.wireSwmHostModeHandler.bind(core);
    vi.spyOn(core, 'wireSwmHostModeHandler').mockImplementation((id, source, curated) => {
      wired.push(id); wire(id, source, curated);
    });

    const result = await g.enableSwmHostModeFor(cgId);

    expect(result.subscribed).toBe(true);
    expect(wired).toEqual([cgId]);
  });

  it.each([undefined, true])('manual strip=%s refuses restored private582 with missing cache and metadata', async strip => {
    const f = await policyCore(1, strip);
    await expect(f.core.enableSwmHostModeFor(f.id)).resolves.toMatchObject({ subscribed: false, alreadySubscribed: false });
    expect(f.g.swmHostModeHandlers.size).toBe(0);
    await f.core.awaitHostModePersistence(f.id);
    expect(await f.g.swmHostModeStore!.listHostModeSubscribedCgs()).toEqual([]);
  });

  it('manual strip ON refuses an unbound graph rather than treating absent privacy as public', async () => {
    const core = await makeCore(true); const g = core as unknown as StripInternals;
    await expect(core.enableSwmHostModeFor('unbound-manual-policy')).resolves.toMatchObject({ subscribed: false });
    expect(g.swmHostModeHandlers.size).toBe(0);
  });

  it('manual strip ON does not borrow public policy from a reverse owner for an exact unbound wire row', async () => {
    const f = await policyCore(0, true, true);
    f.g.setContextGraphSubscription(f.name, { ...f.g.subscribedContextGraphs.get(f.name)!, coreHosted: true }, { persist: false });
    f.g.onChainAccessPolicyCache.set('582', await f.chain.getContextGraphAccessPolicy(582n));
    f.g.subscribedContextGraphs.set(f.hash, { subscribed: false, synced: false, syncMode: 'always-on', onChainHash: f.hash });
    expect(f.g.wireIdToLocalCgId.get(f.hash)).toBe(f.name);
    await expect(f.core.enableSwmHostModeFor(f.hash)).resolves.toMatchObject({ subscribed: false });
    expect(f.g.swmHostModeHandlers.size).toBe(0);
  });

  it('manual strip ON rejects a malformed numeric key even if its cache entry says public', async () => {
    const core = await makeCore(true); const g = core as unknown as StripInternals;
    const id = 'malformed-manual-policy';
    g.subscribedContextGraphs.set(id, { subscribed: false, synced: false, syncMode: 'always-on', onChainId: '0582' });
    g.onChainAccessPolicyCache.set('0582', 0);
    await expect(core.enableSwmHostModeFor(id)).resolves.toMatchObject({ subscribed: false });
    expect(g.swmHostModeHandlers.size).toBe(0);
  });

  it.each([undefined, 'malformed-name-commitment', ethers.keccak256(ethers.toUtf8Bytes('another-manual-graph'))])(
    'manual public cache cannot authorize a missing or conflicting row commitment: %s', async commitment => {
      const f = await policyCore(0, true);
      f.g.onChainAccessPolicyCache.set('582', await f.chain.getContextGraphAccessPolicy(582n));
      f.g.subscribedContextGraphs.get(f.id)!.onChainHash = commitment;
      await expect(f.core.enableSwmHostModeFor(f.id)).resolves.toMatchObject({ subscribed: false });
      expect(f.g.swmHostModeHandlers.size).toBe(0);
    },
  );

  it('manual strip ON admits exact cached public582 without another policy RPC', async () => {
    const f = await policyCore(0, true);
    f.g.onChainAccessPolicyCache.set('582', await f.chain.getContextGraphAccessPolicy(582n));
    const policyRead = vi.spyOn(f.chain, 'getContextGraphAccessPolicy');
    await expect(f.core.enableSwmHostModeFor(f.id)).resolves.toMatchObject({ subscribed: true });
    expect(f.g.swmHostModeHandlers.has(f.hash)).toBe(true);
    expect(f.g.swmHostModeCurated.get(f.hash)).toBe(false);
    expect(policyRead).not.toHaveBeenCalled();
  });

  it('exact cached public identity can enable with no reverse owner and without granting admission', async () => {
    const f = await policyCore(0, true, true);
    f.g.onChainAccessPolicyCache.set('582', await f.chain.getContextGraphAccessPolicy(582n));
    f.g.wireIdToLocalCgId.delete(f.hash);
    await expect(f.core.enableSwmHostModeFor(f.name)).resolves.toMatchObject({ subscribed: true });
    expect(f.g.subscribedContextGraphs.get(f.name)).toMatchObject({ subscribed: false, coreHosted: false });
    expect(f.g.wireIdToLocalCgId.has(f.hash)).toBe(false);
    expect(f.g.swmHostModeHandlers.has(f.hash)).toBe(true);
  });

  it('manual strip OFF retains the explicit override while automatic private dormancy stays refused', async () => {
    const f = await policyCore(1, false);
    await f.core.reconcileSwmHostModeSubscription(f.id);
    expect(f.g.swmHostModeHandlers.size).toBe(0);
    await expect(f.core.enableSwmHostModeFor(f.id)).resolves.toMatchObject({ subscribed: true });
    expect(f.g.swmHostModeSubscribed.get(f.hash)).toBe(SUBSCRIPTION_SOURCES.MANUAL);
  });

  it('manual strip ON closes both dispatches for its existing unknown-policy owner without erasing intent', async () => {
    const f = await policyCore(1, false);
    await f.core.enableSwmHostModeFor(f.id);
    const handler = f.g.swmHostModeHandlers.get(f.hash)!;
    expect(f.g.swmHostModeCurated.get(f.hash)).toBe(false);
    f.g.config.swmHostMode!.stripCiphertext = true;
    const legacy = vi.spyOn(f.core, 'ingestSwmHostModeEnvelope').mockResolvedValue(undefined);
    const chunk = vi.spyOn(f.core, 'ingestSwmCiphertextChunkEnvelope').mockResolvedValue(undefined);
    await expect(f.core.enableSwmHostModeFor(f.id)).resolves.toMatchObject({ subscribed: false, alreadySubscribed: false });
    expect(f.g.swmHostModeHandlers.get(f.hash)).toBe(handler);
    expect(f.g.swmHostModeSubscribed.get(f.hash)).toBe(SUBSCRIPTION_SOURCES.MANUAL);
    expect(f.g.swmHostModeCurated.get(f.hash)).toBe(true);
    handler('', hostEnvelope(f.id, false), 'legacy-probe'); handler('', hostEnvelope(f.id, true), 'chunk-probe');
    expect(legacy).not.toHaveBeenCalled(); expect(chunk).not.toHaveBeenCalled();
    await expect(f.core.enableSwmHostModeFor(f.id)).resolves.toMatchObject({ subscribed: false, alreadySubscribed: false });
    f.g.onChainAccessPolicyCache.set('582', await f.chain.getContextGraphAccessPolicy(582n));
    await expect(f.core.enableSwmHostModeFor(f.id)).resolves.toMatchObject({ subscribed: false, alreadySubscribed: false });
    expect(f.g.swmHostModeCurated.get(f.hash)).toBe(true);
    expect(await f.g.swmHostModeStore!.listHostModeSubscribedCgs()).toContain(f.id);
  });

  it('exact public policy reopens its own previously unknown manual handler', async () => {
    const f = await policyCore(0, false);
    await f.core.enableSwmHostModeFor(f.id);
    const handler = f.g.swmHostModeHandlers.get(f.hash)!;
    f.g.config.swmHostMode!.stripCiphertext = true;
    await expect(f.core.enableSwmHostModeFor(f.id)).resolves.toMatchObject({ subscribed: false, alreadySubscribed: false });
    expect(f.g.swmHostModeCurated.get(f.hash)).toBe(true);
    f.g.onChainAccessPolicyCache.set('582', await f.chain.getContextGraphAccessPolicy(582n));
    const policyRead = vi.spyOn(f.chain, 'getContextGraphAccessPolicy');
    await expect(f.core.enableSwmHostModeFor(f.id)).resolves.toMatchObject({ subscribed: false, alreadySubscribed: true });
    expect(f.g.swmHostModeHandlers.get(f.hash)).toBe(handler);
    expect(f.g.swmHostModeSubscribed.get(f.hash)).toBe(SUBSCRIPTION_SOURCES.MANUAL);
    expect(f.g.swmHostModeCurated.get(f.hash)).toBe(false);
    expect(policyRead).not.toHaveBeenCalled();
    const legacy = vi.spyOn(f.core, 'ingestSwmHostModeEnvelope').mockResolvedValue(undefined);
    const chunk = vi.spyOn(f.core, 'ingestSwmCiphertextChunkEnvelope').mockResolvedValue(undefined);
    handler('', hostEnvelope(f.id, false), 'public-legacy-probe');
    handler('', hostEnvelope(f.id, true), 'public-chunk-probe');
    expect(legacy).toHaveBeenCalledOnce();
    expect(chunk).toHaveBeenCalledOnce();
    expect(await f.g.swmHostModeStore!.listHostModeSubscribedCgs()).toContain(f.id);
  });

  it('manual private refusal preserves an admitted different-slot owner and its dispatch', async () => {
    const f = await policyCore(1, true, true);
    const registration = await f.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: f.hash });
    const slot = String(registration.contextGraphId);
    f.g.setContextGraphSubscription(f.hash, { subscribed: false, synced: false, coreHosted: true, onChainId: slot, onChainHash: f.hash }, { persist: false });
    f.g.onChainAccessPolicyCache.set(slot, await f.chain.getContextGraphAccessPolicy(registration.contextGraphId));
    f.core.wireSwmHostModeHandler(f.hash, SUBSCRIPTION_SOURCES.MANUAL, false);
    const handler = f.g.swmHostModeHandlers.get(f.hash)!;
    expect(f.g.wireIdToLocalCgId.get(f.hash)).toBe(f.hash);
    await expect(f.core.enableSwmHostModeFor(f.name)).resolves.toMatchObject({ subscribed: false, alreadySubscribed: false });
    expect(f.g.swmHostModeHandlers.get(f.hash)).toBe(handler);
    expect(f.g.swmHostModeCurated.get(f.hash)).toBe(false);
    expect(f.g.swmHostModeSubscribed.get(f.hash)).toBe(SUBSCRIPTION_SOURCES.MANUAL);
    const ingest = vi.spyOn(f.core, 'ingestSwmHostModeEnvelope').mockResolvedValue(undefined);
    handler('', hostEnvelope(f.hash, false), 'foreign-owner-probe');
    expect(ingest).toHaveBeenCalledExactlyOnceWith(f.hash, expect.any(Uint8Array), 'foreign-owner-probe');
  });

  it('public manual reentry stands down for an existing private different-slot owner', async () => {
    const f = await policyCore(0, false, true);
    f.g.onChainAccessPolicyCache.set('582', await f.chain.getContextGraphAccessPolicy(582n));
    const registration = await f.chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1, nameHash: f.hash });
    const slot = String(registration.contextGraphId);
    f.g.setContextGraphSubscription(f.hash, { subscribed: false, synced: false, coreHosted: true, onChainId: slot, onChainHash: f.hash }, { persist: false });
    f.g.onChainAccessPolicyCache.set(slot, await f.chain.getContextGraphAccessPolicy(registration.contextGraphId));
    f.core.wireSwmHostModeHandler(f.hash, SUBSCRIPTION_SOURCES.MANUAL, true);
    await f.core.awaitHostModePersistence(f.hash);
    const handler = f.g.swmHostModeHandlers.get(f.hash)!;
    const markers = await f.g.swmHostModeStore!.listHostModeSubscribedCgs();
    f.g.config.swmHostMode!.stripCiphertext = true;
    const registrationProbe = vi.spyOn(f.core, 'maybeMarkRegisteredForHostMode');
    await expect(f.core.enableSwmHostModeFor(f.name)).resolves.toMatchObject({ subscribed: false, alreadySubscribed: false });
    expect(f.g.swmHostModeHandlers.get(f.hash)).toBe(handler);
    expect(f.g.swmHostModeCurated.get(f.hash)).toBe(true);
    expect(f.g.swmHostModeSubscribed.get(f.hash)).toBe(SUBSCRIPTION_SOURCES.MANUAL);
    expect(registrationProbe).not.toHaveBeenCalled();
    expect(await f.g.swmHostModeStore!.listHostModeSubscribedCgs()).toEqual(markers);
  });

  it('manual continuation leaves a captured handler unchanged after its reverse owner changes', async () => {
    const f = await policyCore(0, false, true);
    await f.core.enableSwmHostModeFor(f.name);
    const handler = f.g.swmHostModeHandlers.get(f.hash)!;
    f.g.config.swmHostMode!.stripCiphertext = true;
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.core.isPrivateContextGraph.bind(f.core);
    vi.spyOn(f.core, 'isPrivateContextGraph').mockImplementationOnce(async id => {
      const result = await original(id); entered(); await held; return result;
    });
    const registrationProbe = vi.spyOn(f.core, 'maybeMarkRegisteredForHostMode');
    const enabling = f.core.enableSwmHostModeFor(f.name);
    await started;
    const row = f.g.subscribedContextGraphs.get(f.name);
    const generation = f.g.contextGraphBindingState.capture(f.name);
    f.g.onChainAccessPolicyCache.set('582', await f.chain.getContextGraphAccessPolicy(582n));
    const registration = await f.chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1, nameHash: f.hash });
    f.g.setContextGraphSubscription(f.hash, { subscribed: false, synced: false, coreHosted: true,
      onChainId: String(registration.contextGraphId), onChainHash: f.hash }, { persist: false });
    expect(f.g.subscribedContextGraphs.get(f.name)).toBe(row);
    expect(f.g.contextGraphBindingState.capture(f.name)).toBe(generation);
    release();
    await expect(enabling).resolves.toMatchObject({ subscribed: false, alreadySubscribed: false });
    expect(f.g.swmHostModeHandlers.get(f.hash)).toBe(handler);
    expect(f.g.swmHostModeCurated.get(f.hash)).toBe(false);
    expect(registrationProbe).not.toHaveBeenCalled();
  });

  it('manual dispatch refuses a private rebind during the native marker write', async () => {
    const f = await policyCore(0, true);
    f.g.onChainAccessPolicyCache.set('582', await f.chain.getContextGraphAccessPolicy(582n));
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const store = f.g.swmHostModeStore!;
    const original = store.markHostModeSubscribed.bind(store);
    vi.spyOn(store, 'markHostModeSubscribed').mockImplementationOnce(async id => {
      entered(); await held; await original(id);
    });
    const registrationProbe = vi.spyOn(f.core, 'maybeMarkRegisteredForHostMode');
    const legacy = vi.spyOn(f.core, 'ingestSwmHostModeEnvelope').mockResolvedValue(undefined);
    const chunk = vi.spyOn(f.core, 'ingestSwmCiphertextChunkEnvelope').mockResolvedValue(undefined);
    const enabling = f.core.enableSwmHostModeFor(f.id);
    await started;
    const registration = await f.chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1, nameHash: f.hash });
    f.core.bindSubscriptionOnChainId(f.id, f.g.subscribedContextGraphs.get(f.id)!, String(registration.contextGraphId));
    f.g.onChainAccessPolicyCache.set(String(registration.contextGraphId), await f.chain.getContextGraphAccessPolicy(registration.contextGraphId));
    const handler = f.g.swmHostModeHandlers.get(f.hash)!;
    handler('', hostEnvelope(f.id, false), 'held-private-legacy');
    handler('', hostEnvelope(f.id, true), 'held-private-chunk');
    expect(legacy).not.toHaveBeenCalled(); expect(chunk).not.toHaveBeenCalled();
    release();
    await expect(enabling).resolves.toMatchObject({ subscribed: false, alreadySubscribed: false });
    expect(registrationProbe).not.toHaveBeenCalled();
  });

  it('manual public dispatch fails closed after a later private numeric rebind', async () => {
    const f = await policyCore(0, true);
    f.g.onChainAccessPolicyCache.set('582', await f.chain.getContextGraphAccessPolicy(582n));
    await expect(f.core.enableSwmHostModeFor(f.id)).resolves.toMatchObject({ subscribed: true });
    const registration = await f.chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1, nameHash: f.hash });
    f.core.bindSubscriptionOnChainId(f.id, f.g.subscribedContextGraphs.get(f.id)!, String(registration.contextGraphId));
    f.g.onChainAccessPolicyCache.set(String(registration.contextGraphId), await f.chain.getContextGraphAccessPolicy(registration.contextGraphId));
    const legacy = vi.spyOn(f.core, 'ingestSwmHostModeEnvelope').mockResolvedValue(undefined);
    const chunk = vi.spyOn(f.core, 'ingestSwmCiphertextChunkEnvelope').mockResolvedValue(undefined);
    const handler = f.g.swmHostModeHandlers.get(f.hash)!;
    handler('', hostEnvelope(f.id, false), 'later-private-legacy');
    handler('', hostEnvelope(f.id, true), 'later-private-chunk');
    expect(legacy).not.toHaveBeenCalled(); expect(chunk).not.toHaveBeenCalled();
  });

  it('manual public dispatch survives genuine same-slot native cleartext adoption', async () => {
    const f = await policyCore(0, true);
    f.g.onChainAccessPolicyCache.set('582', await f.chain.getContextGraphAccessPolicy(582n));
    await expect(f.core.enableSwmHostModeFor(f.id)).resolves.toMatchObject({ subscribed: true });
    const handler = f.g.swmHostModeHandlers.get(f.hash)!;
    f.g.setContextGraphSubscription(f.name, { subscribed: true, synced: true, onChainId: '582', onChainHash: f.hash }, { persist: false });
    expect(f.g.subscribedContextGraphs.has(f.hash)).toBe(false);
    expect(f.g.wireIdToLocalCgId.get(f.hash)).toBe(f.name);
    expect(f.g.swmHostModeHandlers.get(f.hash)).toBe(handler);
    const legacy = vi.spyOn(f.core, 'ingestSwmHostModeEnvelope').mockResolvedValue(undefined);
    const chunk = vi.spyOn(f.core, 'ingestSwmCiphertextChunkEnvelope').mockResolvedValue(undefined);
    handler('', hostEnvelope(f.id, false), 'adopted-public-legacy');
    handler('', hostEnvelope(f.id, true), 'adopted-public-chunk');
    expect(legacy).toHaveBeenCalledOnce(); expect(chunk).toHaveBeenCalledOnce();
  });

  it.each(['session', 'numeric-rebind'] as const)('manual policy continuation stands down after %s changes', async mutation => {
    const f = await policyCore(1, true);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.core.isPrivateContextGraph.bind(f.core);
    vi.spyOn(f.core, 'isPrivateContextGraph').mockImplementationOnce(async id => { const result = await original(id); entered(); await held; return result; });
    const enabling = f.core.enableSwmHostModeFor(f.id); await started;
    if (mutation === 'session') installGossipStub(f.g);
    else {
      const registration = await f.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: f.hash });
      f.core.bindSubscriptionOnChainId(f.id, f.g.subscribedContextGraphs.get(f.id)!, String(registration.contextGraphId));
      f.g.onChainAccessPolicyCache.set(String(registration.contextGraphId), await f.chain.getContextGraphAccessPolicy(registration.contextGraphId));
    }
    release(); await expect(enabling).resolves.toMatchObject({ subscribed: false });
    expect(f.g.swmHostModeHandlers.size).toBe(0);
  });

  it('strip ON gates both legacy and chunked dispatch for a curated handler', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-curated-dispatch';
    const legacyIngest = vi.fn(async () => {});
    const chunkIngest = vi.fn(async () => {});
    g.ingestSwmHostModeEnvelope = legacyIngest;
    g.ingestSwmCiphertextChunkEnvelope = chunkIngest;
    installGossipStub(g);

    g.wireSwmHostModeHandler(cgId, undefined, true);
    const handler = [...g.swmHostModeHandlers.values()][0]!;
    handler('', hostEnvelope(cgId, false), 'peer-legacy');
    handler('', hostEnvelope(cgId, true), 'peer-chunk');

    expect(legacyIngest).not.toHaveBeenCalled();
    expect(chunkIngest).not.toHaveBeenCalled();
  });

  it('strip ON preserves both dispatch branches for an explicitly non-curated handler', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-public-dispatch';
    const legacyIngest = vi.fn(async () => {});
    const chunkIngest = vi.fn(async () => {});
    g.ingestSwmHostModeEnvelope = legacyIngest;
    g.ingestSwmCiphertextChunkEnvelope = chunkIngest;
    installGossipStub(g);

    g.wireSwmHostModeHandler(cgId, undefined, false);
    const handler = [...g.swmHostModeHandlers.values()][0]!;
    handler('', hostEnvelope(cgId, false), 'peer-legacy');
    handler('', hostEnvelope(cgId, true), 'peer-chunk');

    expect(legacyIngest).toHaveBeenCalledOnce();
    expect(chunkIngest).toHaveBeenCalledOnce();
  });

  it('reconciliation upgrades a stale non-curated handler before later dispatch', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-becomes-curated';
    const legacyIngest = vi.fn(async () => {});
    const chunkIngest = vi.fn(async () => {});
    g.ingestSwmHostModeEnvelope = legacyIngest;
    g.ingestSwmCiphertextChunkEnvelope = chunkIngest;
    installGossipStub(g);

    g.wireSwmHostModeHandler(cgId, undefined, false);
    await installCurated(core, cgId);
    await g.reconcileSwmHostModeSubscription(cgId);

    expect([...g.swmHostModeCurated.values()]).toEqual([true]);
    const handler = [...g.swmHostModeHandlers.values()][0]!;
    handler('', hostEnvelope(cgId, false), 'peer-legacy');
    handler('', hostEnvelope(cgId, true), 'peer-chunk');
    expect(legacyIngest).not.toHaveBeenCalled();
    expect(chunkIngest).not.toHaveBeenCalled();
  });

  // ── 3 + 4. serve responders RETIRED ──────────────────────────────────────

  it('strip ON RETIRES handleSwmHostCatchup — serves nothing private', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    // Garbage request bytes are fine: with no public host tier on this core
    // the strip still denies BEFORE decoding.
    const resp = await g.handleSwmHostCatchup(new Uint8Array([1, 2, 3]), '12D3KooWPeer');
    const decoded = decodeSwmHostCatchupResponse(resp);
    expect(decoded.entries).toEqual([]);
    expect(decoded.denied ?? '').toMatch(/strip is on/i);
  });

  it('strip ON EXEMPTS a confirmed-public host-tier CG from the catch-up retirement', async () => {
    // GH #1611 — the public tier appends envelopes under the strip; denying
    // every catch-up would make that retention permanently unreadable. The
    // exemption is per CG and re-confirmed against chain state, so a curated
    // (or unclassified) CG on the SAME core is still refused at the strip gate.
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    installGossipStub(g);
    const publicCg = 'cg-public-catchup';
    const curatedCg = 'cg-curated-catchup';
    // Codex review #2614 — a CG hosted as non-curated whose owner curated it
    // AFTER the marker was written. It passes the free local gate, so it is the
    // only case where the chain re-confirmation actually decides the outcome.
    const lateCuratedCg = 'cg-late-curated-catchup';
    const throwingCg = 'cg-policy-throws-catchup';
    g.wireSwmHostModeHandler(publicCg, undefined, false); // public host tier
    g.wireSwmHostModeHandler(curatedCg, undefined, true);
    g.wireSwmHostModeHandler(lateCuratedCg, undefined, false);
    g.wireSwmHostModeHandler(throwingCg, undefined, false);
    const confirmed: string[] = [];
    g.isConfirmedPublicForHostMode = async (id: string) => {
      confirmed.push(id);
      if (id === throwingCg) throw new Error('simulated policy resolver failure');
      return id === publicCg;
    };

    const request = (cgId: string): Uint8Array => encodeSwmHostCatchupRequest({
      version: SWM_HOST_CATCHUP_WIRE_VERSION,
      contextGraphId: cgId,
      sinceSeqno: 0,
      requesterEoa: '0x' + '22'.repeat(20),
      issuedAtMs: Date.now(),
      nonce: '0x' + '33'.repeat(16),
      sig: '0x' + '44'.repeat(65),
    });

    // The public CG gets PAST the strip gate — it fails later, on the ordinary
    // LU-6 B1 authorization of an unsigned-by-anyone request, not on the strip.
    const publicResp = decodeSwmHostCatchupResponse(
      await g.handleSwmHostCatchup(request(publicCg), '12D3KooWPeer'),
    );
    expect(publicResp.denied ?? '').not.toMatch(/strip is on/i);
    expect(confirmed).toEqual([publicCg]);

    // The curated CG on the same core never reaches the chain re-confirmation:
    // the free `swmHostModeCurated` gate refuses it first.
    const curatedResp = decodeSwmHostCatchupResponse(
      await g.handleSwmHostCatchup(request(curatedCg), '12D3KooWPeer'),
    );
    expect(curatedResp.entries).toEqual([]);
    expect(curatedResp.denied ?? '').toMatch(/strip is on/i);
    expect(confirmed).toEqual([publicCg]);

    // An unclassified CG (e.g. legacy ciphertext left on disk from before the
    // strip rolled out) fails closed the same way.
    const unknownResp = decodeSwmHostCatchupResponse(
      await g.handleSwmHostCatchup(request('cg-never-wired'), '12D3KooWPeer'),
    );
    expect(unknownResp.denied ?? '').toMatch(/strip is on/i);
    expect(confirmed).toEqual([publicCg]);

    // The chain leg is the DECIDING condition here: the CG passes the free
    // local gate and is refused only because chain state says it is no longer
    // public. Deleting the leg would serve it.
    const lateCuratedResp = decodeSwmHostCatchupResponse(
      await g.handleSwmHostCatchup(request(lateCuratedCg), '12D3KooWPeer'),
    );
    expect(lateCuratedResp.entries).toEqual([]);
    expect(lateCuratedResp.denied ?? '').toMatch(/strip is on/i);
    expect(confirmed).toEqual([publicCg, lateCuratedCg]);

    // A resolver failure denies too (fail closed), and still answers with a
    // structured response rather than throwing at the messenger substrate.
    const throwingResp = decodeSwmHostCatchupResponse(
      await g.handleSwmHostCatchup(request(throwingCg), '12D3KooWPeer'),
    );
    expect(throwingResp.entries).toEqual([]);
    expect(throwingResp.denied ?? '').toMatch(/strip is on/i);
    expect(confirmed).toEqual([publicCg, lateCuratedCg, throwingCg]);
  });

  it('strip ON RETIRES handleGetCiphertextChunk — serves nothing private (incl. RFC-39 operator branch)', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const resp = await g.handleGetCiphertextChunk(new Uint8Array([4, 5, 6]), '12D3KooWPeer');
    const decoded = decodeCiphertextChunkCatchupResponse(resp);
    expect(decoded.ciphertextB64).toBeUndefined();
    expect(decoded.denied ?? '').toMatch(/strip is on/i);
  });

  it('strip OFF (baseline) does NOT retire the serve responders at the strip gate', async () => {
    const core = await makeCore(false);
    const g = core as unknown as StripInternals;
    // With the strip OFF the responders proceed to decode; garbage bytes now
    // yield a DECODE-level denial, NOT the strip denial. The point is only that
    // the strip gate did not short-circuit the path.
    const hostResp = decodeSwmHostCatchupResponse(await g.handleSwmHostCatchup(new Uint8Array([1, 2, 3]), '12D3KooWPeer'));
    expect(hostResp.denied ?? '').not.toMatch(/strip is on/i);
    const chunkResp = decodeCiphertextChunkCatchupResponse(await g.handleGetCiphertextChunk(new Uint8Array([4, 5, 6]), '12D3KooWPeer'));
    expect(chunkResp.denied ?? '').not.toMatch(/strip is on/i);
  });
});

// ── 5. chooseFanOutTier — private authoritative roster drops gossip ───────

describe('OT-RFC-49 WS-A — chooseFanOutTier private-CG gossip gate', () => {
  const allowlist = (members: string[]): CGMemberEnumeration => ({
    members,
    source: 'allowlist',
    isPrivate: true,
  });
  const agentRoster = (members: string[]): CGMemberEnumeration => ({
    members,
    source: 'agent-roster',
    complete: true,
  });

  const base = (enumeration: CGMemberEnumeration): ChooseFanOutTierInput => ({
    enumeration,
    maxSubstrateMembers: 100,
  });

  it('private allowlist CG with a roster → substrate ON, gossip OFF', () => {
    const plan = chooseFanOutTier(base(allowlist(['12D3KooWA', '12D3KooWB'])));
    expect(plan.useSubstrate).toBe(true);
    expect(plan.useGossip).toBe(false);
    expect(plan.substrateMembers).toEqual(['12D3KooWA', '12D3KooWB']);
  });

  it('private allowlist CG with an EMPTY roster → keeps gossip ON (no silent drop)', () => {
    const plan = chooseFanOutTier(base(allowlist([])));
    expect(plan.useGossip).toBe(true);
  });

  it('private agent-gated CG with an authorized roster → substrate ON, gossip OFF', () => {
    const plan = chooseFanOutTier(base(agentRoster(['12D3KooWAgentPeer'])));
    expect(plan.useSubstrate).toBe(true);
    expect(plan.useGossip).toBe(false);
    expect(plan.substrateMembers).toEqual(['12D3KooWAgentPeer']);
    expect(plan.enumerationSource).toBe('agent-roster');
  });

  it('public allowlist CG (isPrivate falsey) → gossip stays ON (cross-version safety net)', () => {
    const plan = chooseFanOutTier(base({ members: ['12D3KooWA'], source: 'allowlist', isPrivate: false }));
    expect(plan.useGossip).toBe(true);
  });

  it("private 'none' tier is NOT touched — gossip stays ON (its only transport)", () => {
    const plan = chooseFanOutTier(base({ members: [], source: 'none' }));
    expect(plan.useSubstrate).toBe(false);
    expect(plan.useGossip).toBe(true);
  });
});
