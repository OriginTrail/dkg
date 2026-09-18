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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '../../src/index.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  encodeGossipEnvelope,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
  type SubscriptionSource,
} from '@origintrail-official/dkg-core';
import {
  chooseFanOutTier,
  type ChooseFanOutTierInput,
} from '../../src/swm/substrate-fanout.js';
import type { CGMemberEnumeration } from '../../src/swm/enumerate-cg-members.js';
import {
  decodeSwmHostCatchupResponse,
} from '../../src/swm/host-catchup-wire.js';
import {
  decodeCiphertextChunkCatchupResponse,
} from '../../src/swm/ciphertext-chunk-catchup.js';

interface StripInternals {
  swmHostModeStore?: SwmHostModeStore;
  swmHostModeHandlers: Map<string, (topic: string, data: Uint8Array, from: string) => void>;
  swmHostModeSubscribed: Map<string, SubscriptionSource>;
  swmHostModeCurated: Map<string, boolean>;
  gossip: {
    subscribe(topic: string): void;
    onMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void): void;
  };
  subscribedContextGraphs: Map<string, { subscribed: boolean; synced: boolean; onChainHash?: string; onChainId?: string }>;
  onChainAccessPolicyCache: Map<string, number>;
  beaconCuratorByWireId: Map<string, string>;
  swmHostModeRestoreDrain?: Promise<void>;
  config: { swmHostMode?: { enabled?: boolean; hostPublic?: boolean; stripCiphertext?: boolean } };
  isPrivateContextGraph(cgId: string): Promise<boolean>;
  isConfirmedPublicForHostMode(cgId: string): Promise<boolean>;
  wireSwmHostModeHandler(cgId: string, source?: SubscriptionSource, curated?: boolean): void;
  reconcileSwmHostModeSubscription(cgId: string): Promise<void>;
  ingestSwmHostModeEnvelope(cgId: string, data: Uint8Array, from: string): Promise<void>;
  ingestSwmCiphertextChunkEnvelope(cgId: string, data: Uint8Array, from: string): Promise<void>;
  enableSwmHostModeFor(cgId: string): Promise<{
    subscribed: boolean; alreadySubscribed: boolean; hostingEnabled: boolean; memberMode?: boolean;
  }>;
  handleSwmHostCatchup(data: Uint8Array, fromPeerId: string): Promise<Uint8Array>;
  handleGetCiphertextChunk(data: Uint8Array, fromPeerId: string): Promise<Uint8Array>;
  initializeSwmHostModeStore(): Promise<void>;
  stageOnChainContextGraphBindingFromNameHash(nameHash: string, onChainId: string): string | null;
  enqueueHostModePersistence(contextGraphId: string, subscribe: boolean): void;
  awaitHostModePersistence(contextGraphId: string): Promise<void>;
}

/** A curated CG: any `onChainHash` makes the three-source curation probe in
 * `reconcileSwmHostModeSubscription` resolve "curated" via its cheapest branch. */
const CURATED = (id: string): { subscribed: boolean; synced: boolean; onChainHash: string } => ({
  subscribed: true,
  synced: true,
  onChainHash: ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase(),
});

function markCurated(g: StripInternals, id: string): void {
  g.onChainAccessPolicyCache.set('1', 1);
  g.subscribedContextGraphs.set(id, { ...CURATED(id), onChainId: '1' });
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
  async function makeCore(strip?: boolean): Promise<DKGAgent> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-strip-ct-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({
      name: 'StripCiphertextCore',
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      rfc64CatalogActivation: { enabled: false },
      swmHostMode: strip === undefined ? { enabled: true } : { enabled: true, stripCiphertext: strip },
    });
    agents.push(core);
    const store = new SwmHostModeStore({
      dataDir: join(dataDir, 'swm-host'),
      ...SwmHostModeStore.defaultLimits(),
    });
    await store.init();
    (core as unknown as StripInternals).swmHostModeStore = store;
    return core;
  }

  // ── 1. reconcile subscribe-decline (primary choke point) ─────────────────

  it('default (no flag) DECLINES host-mode subscribe for a curated CG — strip is ON by default', async () => {
    const core = await makeCore(); // no stripCiphertext → undefined → ON
    const g = core as unknown as StripInternals;
    const cgId = 'cg-curated-default';
    markCurated(g, cgId);
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([]);
    expect(g.swmHostModeHandlers.size).toBe(0);
  });

  it('strip ON DECLINES host-mode subscribe for a curated CG (no handler wired)', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-curated-stripped';
    markCurated(g, cgId);
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

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
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

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
  });

  it('strip OFF (baseline) WIRES host-mode subscribe for a curated CG', async () => {
    const core = await makeCore(false);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-curated-baseline';
    markCurated(g, cgId);
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

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
    const cgId = 'cg-curated-restore';
    const store = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await store.init();
    g.swmHostModeStore = store;
    await store.markHostModeSubscribed(cgId);
    (g as any).maybeMarkRegisteredForHostMode = async () => {};
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => {
      wired.push(id);
    };

    await g.initializeSwmHostModeStore();

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
    const cgIds = ['cg-b1', 'cg-b2', 'cg-b3', 'cg-b4', 'cg-b5'];
    for (const cgId of cgIds) await store.markHostModeSubscribed(cgId);
    (g as any).maybeMarkRegisteredForHostMode = async () => {};
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => {
      wired.push(id);
    };

    await g.initializeSwmHostModeStore();

    expect(wired).toHaveLength(2);
    expect(g.swmHostModeRestoreDrain).toBeDefined();

    await g.swmHostModeRestoreDrain;

    expect([...wired].sort()).toEqual([...cgIds].sort());
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
  });

  // ── 2. operator override hatch CLOSED (WS-A divergence from rung-1) ───────

  it('strip ON CLOSES the operator override `enableSwmHostModeFor` for a curated CG', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-operator-curated';
    g.isPrivateContextGraph = async () => true; // curated
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

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
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

    const result = await g.enableSwmHostModeFor(cgId);

    expect(result.subscribed).toBe(true);
    expect(wired).toEqual([cgId]);
  });

  it('strip ON CLOSES the operator hatch for a host-only core (curated via onChainHash, NO local _meta)', async () => {
    // The WS-A target case: a core that learned of a curated CG via
    // chain-event/beacon has NO local `_meta`, so `isPrivateContextGraph`
    // returns false. The operator hatch must STILL refuse — it consults the
    // same three-source curation probe (`onChainHash`) the auto-host path uses,
    // not `isPrivateContextGraph` alone.
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-host-only-core';
    markCurated(g, cgId); // curated via the chain policy cache
    g.isPrivateContextGraph = async () => false;        // no local _meta
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

    const result = await g.enableSwmHostModeFor(cgId);

    expect(result).toEqual({ subscribed: false, alreadySubscribed: false, hostingEnabled: true });
    expect(wired).toEqual([]);
  });

  it('strip ON does NOT affect the operator override for a PUBLIC/uncurated CG', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-operator-public';
    g.isPrivateContextGraph = async () => false; // public — never stripped
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

    const result = await g.enableSwmHostModeFor(cgId);

    expect(result.subscribed).toBe(true);
    expect(wired).toEqual([cgId]);
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
    markCurated(g, cgId);
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
    // Garbage request bytes are fine: the strip denies BEFORE decoding.
    const resp = await g.handleSwmHostCatchup(new Uint8Array([1, 2, 3]), '12D3KooWPeer');
    const decoded = decodeSwmHostCatchupResponse(resp);
    expect(decoded.entries).toEqual([]);
    expect(decoded.denied ?? '').toMatch(/strip is on/i);
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
