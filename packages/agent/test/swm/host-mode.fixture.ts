import { afterEach, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '../../src/index.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';
import type { ContextGraphSub, ContextGraphSubInput, ContextGraphSubscriptionRecord } from '../../src/dkg-agent-types.js';
import { encodeGossipEnvelope, GOSSIP_ENVELOPE_VERSION, GOSSIP_TYPE_WORKSPACE_PUBLISH,
  GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED, type SubscriptionSource } from '@origintrail-official/dkg-core';
export interface StripInternals {
  swmHostModeStore?: SwmHostModeStore;
  swmHostModeRestoration?: import('../../src/internal/host-mode-restoration.js').HostModeRestoration;
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
  config: { dataDir: string; swmHostMode?: { enabled?: boolean; stripCiphertext?: boolean; hostPublic?: boolean; reconcileBatchSize?: number } };
  beacons: { lookupWireId(contextGraphId: string): { publisherAddress: string; curatorAddress: string; onChainContextGraphId?: string } | undefined };
  isPrivateContextGraph(cgId: string): Promise<boolean>;
  isConfirmedPublicForHostMode(cgId: string): Promise<boolean>;
  wireSwmHostModeHandler(cgId: string, source?: SubscriptionSource, custody?: import('../../src/gossip-session.js').SwmHostModeCustody): boolean;
  reconcileSwmHostModeSubscription(cgId: string): Promise<void>;
  swmHostModePublicPolicy(): { captureCurrent(id: string): () => boolean };
  ingestSwmHostModeEnvelope(cgId: string, data: Uint8Array, from: string, admissionCurrent?: () => boolean): Promise<void>;
  ingestSwmCiphertextChunkEnvelope(cgId: string, data: Uint8Array, from: string, admissionCurrent?: () => boolean): Promise<void>;
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

export async function installCurated(core: DKGAgent, id: string): Promise<void> {
  const g = core as unknown as StripInternals;
  const hash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
  const registration = await g.chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1, nameHash: hash });
  g.subscribedContextGraphs.set(id, { subscribed: true, synced: true, syncMode: 'always-on', onChainHash: hash, onChainId: String(registration.contextGraphId) });
  g.onChainAccessPolicyCache.set(String(registration.contextGraphId), await g.chain.getContextGraphAccessPolicy(registration.contextGraphId));
}

export function hostEnvelope(contextGraphId: string, chunked: boolean): Uint8Array {
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

export function installGossipStub(g: StripInternals): void {
  g.gossip = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    offMessage: vi.fn(),
    onMessage: vi.fn(),
  };
}

export function createHostModeTestFixture() {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.stop().catch(() => {}).then(() => a.store.close().catch(() => {}))));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** A core with a host-mode store installed. `strip` toggles the WS-A flag;
   * omit it to exercise the DEFAULT (strip ON). A null chain preserves the
   * agent’s default NoChain adapter for legacy restoration scenarios. */
  async function makeCore(strip?: boolean, options: { chain?: MockChainAdapter | null; saved?: ContextGraphSubscriptionRecord; hostPublic?: boolean; reconcileBatchSize?: number; dataDir?: string } = {}): Promise<DKGAgent> {
    const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'dkg-strip-ct-'));
    if (options.dataDir === undefined) tempDirs.push(dataDir);
    const core = await DKGAgent.create({
      name: 'StripCiphertextCore',
      ...(options.chain === null ? {} : { chainAdapter: options.chain ?? new MockChainAdapter() }),
      ...(options.saved ? { contextGraphSubscriptionRehydrationEnabled: false,
        contextGraphSubscriptionStore: { loadAll: async () => [{ ...options.saved! }], save: async () => {}, delete: async () => {} } } : {}),
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      rfc64CatalogActivation: { enabled: false },
      swmHostMode: { enabled: true, ...(strip === undefined ? {} : { stripCiphertext: strip }),
        ...(options.hostPublic === undefined ? {} : { hostPublic: options.hostPublic }),
        ...(options.reconcileBatchSize === undefined ? {} : { reconcileBatchSize: options.reconcileBatchSize }) },
    });
    agents.push(core);
    if (options.saved) (core as unknown as { node: unknown }).node = { peerId: '12D3KooWStripPolicy', libp2p: { getPeers: () => [] } };
    installGossipStub(core as unknown as StripInternals);
    const limits = SwmHostModeStore.defaultLimits();
    const store = new SwmHostModeStore({
      dataDir: join(dataDir, 'swm-host'),
      unregisteredLimits: limits.unregistered, registeredLimits: limits.registered,
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

  return { tempDirs, agents, makeCore, policyCore };
}
