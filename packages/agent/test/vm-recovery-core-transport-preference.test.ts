import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext, PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import {
  getSyncBackpressureBusyError,
  resolveSyncGlobalBackpressure,
  withGlobalSyncBackpressure,
} from '../src/sync/backpressure.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

const older = '12D3KooWAAOlderReplica';
const core = '12D3KooWZZVerifiedCore';
const third = '12D3KooWZZZOtherReplica';
const cg = '0x0000000000000000000000000000000000000001/core-transport';
type Harness = Awaited<ReturnType<typeof harness>>;
const agents: Array<{ stop(): Promise<void> }> = [];

async function harness(accessPolicy: 0 | 1 = 0, behavior?: (peer: string, ordinal: number) => 'found' | 'clean-absent' | 'incomplete' | 'unverified', peers = [older, core], options: { targetCount?: number; knownSizing?: boolean } = {}) {
  const h = await createVmRecoveryHostHarness({
    name: 'VmCoreTransportPreference', localCgId: cg, peers,
    targetCount: options.targetCount ?? 7, sizingUnavailable: !options.knownSizing, accessPolicy,
    footprintForOrdinal: () => ({ byteSize: 32_768n, merkleLeafCount: 500n }),
    targetForOrdinal: (ordinal) => ({ localCgId: cg, onChainCgId: '1', ordinal,
      kaId: String(ordinal), merkleRoot: `root-${ordinal}`, reason: 'no-swm' as const,
      ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}` }),
    onFetch: (peer, targets, recovered) => {
      const outcome = behavior?.(peer, targets[0]!.ordinal) ?? (peer === older ? 'clean-absent' : 'found');
      if (outcome === 'found') for (const target of targets) recovered.add(target.ordinal);
      return outcome === 'unverified' ? 'found' : outcome;
    },
  });
  agents.push(h.agent);
  h.internals.peerCapabilityRegistry.observe(core, { source: 'identify', protocols: [PROTOCOL_STORAGE_ACK] });
  return h;
}

function remaining(h: Harness) { return h.targets.filter(({ ordinal }) => !h.recovered.has(ordinal)); }
function next(h: Harness) { return h.internals.recoverVmReconcileBatch(cg, 1n, remaining(h), 100, () => true); }
function remember(h: Harness, graph = cg) {
  return h.internals.rememberVmReconcilePublicCoreTransportPreference(graph, '1', core,
    h.internals.getSyncReconcilerConnectionKey(core));
}

async function carriedHarness(behavior?: Parameters<typeof harness>[1], peers = [older, core, third]) {
  vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '1');
  const h = await harness(0, behavior, peers, { targetCount: 35, knownSizing: true });
  // Exercise ordinary exact transport under the experimental holder flag;
  // advertising streaming support is not what earns the holder proof.
  vi.spyOn(h.agent, 'getPeerProtocols').mockResolvedValue([]);
  await h.run();
  expect(h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)?.holderCredit).toBeDefined();
  return h;
}
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await Promise.all(agents.splice(0).map((agent) => agent.stop())); });

describe('verified public Core transport preference', () => {
  it('keeps the verified Core across slices, yields after one reuse and leaves untouched KAs pending', async () => {
    const h = await harness(0, undefined, [older, core, third]);
    const originalCurator = h.internals.preferredSyncPeers.get(cg);
    const first = await h.run();
    expect(h.fetched.map(({ peerId }) => peerId)).toEqual([older, core, core]);
    expect(first.attemptedOrdinals).toEqual([0, 1, 2]);
    expect(first.continuationOrdinal).toBe(3);
    expect(first.outcomes.get(0)?.status).toBe('pending');
    const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
    expect([...record.candidatePeerIds]).toEqual([older, core, third]);
    expect([...record.cleanAbsentPeerIds]).toEqual([older]);
    const second = await next(h);
    expect(h.fetched.slice(3)).toEqual([
      { peerId: core, uals: [h.targets[0]!.ual] },
      { peerId: core, uals: [h.targets[3]!.ual] },
    ]);
    expect(second.attemptedOrdinals).toEqual([0, 3]);
    expect(second.continuationOrdinal).toBe(4);
    expect([...h.recovered].sort()).toEqual([0, 1, 2, 3]);
    expect(second.outcomes.has(4)).toBe(false);
    expect(h.internals.preferredSyncPeers.get(cg)).toBe(originalCurator);
    for (const pending of [4, 5, 6]) {
      const untouched = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[pending]!))!;
      expect([...untouched.candidatePeerIds]).toEqual([older, core, third]);
      expect(untouched.attemptedPeerIds.size).toBe(0);
      expect(untouched.cleanAbsentPeerIds.size).toBe(0);
    }
    expect(h.maxActiveFetches()).toBe(1);
  });

  it.each(['clean-absent', 'incomplete', 'unverified'] as const)('revokes preference after %s and falls back without crediting that KA', async (failure) => {
    let fail = false;
    const h = await harness(0, (peer) => fail ? (peer === core ? failure : 'found') : (peer === older ? 'clean-absent' : 'found'));
    await h.run(); fail = true;
    const result = await next(h);
    expect(h.fetched.slice(3).map(({ peerId }) => peerId)).toEqual([core, older, older]);
    expect(result.outcomes.get(0)?.status).toBe('pending');
    expect(h.recovered.has(0)).toBe(false);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
  });

  it('revokes preference after protocol/network readiness fails and selects another original candidate', async () => {
    const h = await harness(); await h.run();
    h.internals.waitForSyncProtocol = async (peer) => peer.toString() !== core;
    const result = await next(h);
    expect(h.fetched.slice(3).map(({ peerId }) => peerId)).toEqual([older]);
    expect(result.outcomes.has(0)).toBe(false);
    expect(h.recovered.has(0)).toBe(false);
    const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
    expect(record.attemptedPeerIds.has(core)).toBe(true);
    expect(record.cleanAbsentPeerIds.has(core)).toBe(false);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
  });

  it('revokes preference after a transport exception without turning it into clean absence', async () => {
    let fail = false;
    const h = await harness(0, (peer) => {
      if (fail && peer === core) throw new Error('transport disconnected');
      return fail || peer !== older ? 'found' : 'clean-absent';
    });
    await h.run(); fail = true;
    const result = await next(h);
    expect(h.fetched.slice(3).map(({ peerId }) => peerId)).toEqual([core, older, older]);
    expect(result.outcomes.get(0)?.status).toBe('pending');
    const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
    expect(record.cleanAbsentPeerIds.has(core)).toBe(false);
    expect(h.recovered.has(0)).toBe(false);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
  });

  it('retains the original roster and three-provider transport cap when preferred recovery fails', async () => {
    const fourth = '12D3KooWZZZZFourthReplica';
    const peers = [older, core, third, fourth];
    const baseline = await harness(0, () => 'incomplete', peers);
    const preferred = await harness(0, () => 'incomplete', peers);
    expect(remember(preferred)).toBe(true);
    const [normalResult, preferredResult] = await Promise.all([baseline.run(), preferred.run()]);
    expect(baseline.fetched.map(({ peerId }) => peerId)).toEqual([older, core, third]);
    expect(preferred.fetched.map(({ peerId }) => peerId)).toEqual([core, older, third]);
    for (const [h, result] of [[baseline, normalResult], [preferred, preferredResult]] as const) {
      expect(new Set(h.fetched.map(({ peerId }) => peerId)).size).toBe(DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX);
      expect(result.attemptedOrdinals).toEqual([0, 1, 2]);
      expect(result.continuationOrdinal).toBe(3);
      expect(h.recovered.size).toBe(0);
      for (const target of h.targets) {
        const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(target))!;
        expect([...record.candidatePeerIds]).toEqual(peers);
        expect(record.cleanAbsentPeerIds.size).toBe(0);
      }
    }
  });

  it('does not learn a Core preference or yield early for a private graph', async () => {
    const h = await harness(1, undefined, [older, core, third]);
    const result = await h.run();
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.size).toBe(0);
    expect(h.fetched.map(({ peerId }) => peerId)).toEqual([older, core, core, third, third]);
    expect(result.continuationOrdinal).toBe(5);
  });

  it('revokes a prior preference when the existing public-policy sizing read fails', async () => {
    const h = await harness(0, undefined, [older, core, third]);
    expect(remember(h)).toBe(true);
    vi.spyOn(h.agent, 'readLiveOnChainAccessPolicy').mockRejectedValue(new Error('policy unavailable'));
    const result = await h.run();
    expect(h.fetched.map(({ peerId }) => peerId)).toEqual([core, core, older, third, third]);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.size).toBe(0);
    expect(result.continuationOrdinal).toBe(5);
  });

  it('does not learn from a verified response completed on a replaced connection', async () => {
    let h: Harness;
    h = await harness(0, (peer, ordinal) => {
      if (peer === core && ordinal === 2) {
        h.internals.node.libp2p.getConnections = () => [older, core, third].map((peerId) => ({
          remotePeer: { toString: () => peerId }, timeline: { open: 99 },
        }));
      }
      return peer === older ? 'clean-absent' : 'found';
    }, [older, core, third]);
    await h.run();
    expect(h.recovered.has(2)).toBe(true);
    expect(h.fetched.map(({ peerId }) => peerId)).toEqual([older, core, core, third, third]);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.size).toBe(0);
  });

  it.each(['shutdown', 'restart', 'rebind'] as const)('does not repopulate a stale hint when %s follows a completed executor result', async (change) => {
    const h = await harness(0, undefined, [older, core, third]);
    let current = true;
    let completedReuse = false;
    const execute = h.internals.executeVmRecoveryBatch.bind(h.internals);
    h.internals.executeVmRecoveryBatch = async (input) => {
      const result = await execute(input);
      if (input.attempts[0]!.entry.target.ordinal === 2 && result.kind === 'completed') {
        completedReuse = true;
        // The executor has checked currency; its caller has not resumed yet.
        if (change === 'rebind') {
          current = false;
          h.internals.clearVmReconcileRotationStateForContextGraph(cg);
          expect(h.internals.rememberVmReconcilePublicCoreTransportPreference(
            cg, '2', core, h.internals.getSyncReconcilerConnectionKey(core),
          )).toBe(true);
        } else {
          h.internals.closeVmReconcileRotationState();
          if (change === 'restart') h.internals.openVmReconcileRotationState();
        }
      }
      return result;
    };
    const result = await h.internals.recoverVmReconcileBatch(cg, 1n, h.targets, 100, () => current);
    expect(completedReuse).toBe(true);
    expect(h.fetched.map(({ peerId }) => peerId)).toEqual([older, core, core]);
    expect(result.attemptedOrdinals).toEqual([]);
    expect(result.outcomes.size).toBe(0);
    if (change === 'rebind') {
      expect(h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)?.onChainCgId).toBe('2');
    } else {
      expect(h.internals.vmReconcilePublicCoreTransportPreferences.size).toBe(0);
    }
  });

  it.each(['binding', 'expiry', 'reconnect', 'disconnect', 'role'] as const)('invalidates %s without changing proof membership or presence', async (change) => {
    const h = await harness(); expect(remember(h)).toBe(true);
    let now = h.internals.vmReconcileRotationNow();
    h.internals.vmReconcileRotationNow = () => now;
    let binding = '1';
    if (change === 'binding') binding = '2';
    if (change === 'expiry') now += DKGAgentBase.VM_RECONCILE_PUBLIC_CORE_TRANSPORT_TTL_MS + 1;
    if (change === 'disconnect') h.internals.node.libp2p.getConnections = () => [];
    if (change === 'reconnect') h.internals.node.libp2p.getConnections = () => [{ remotePeer: { toString: () => core }, timeline: { open: 99 } }];
    if (change === 'role') h.internals.peerCapabilityRegistry.forget(core);
    expect(h.internals.readVmReconcilePublicCoreTransportPreference(cg, binding, [older, core])).toBeUndefined();
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.size).toBe(0);
    expect(h.internals.vmReconcileRotationState.size).toBe(0);
    expect(h.recovered.size).toBe(0);
  });

  it('cannot introduce a missing or already credited candidate', async () => {
    const h = await harness(); expect(remember(h)).toBe(true);
    expect(h.internals.readVmReconcilePublicCoreTransportPreference(cg, '1', [older])).toBeUndefined();
    expect(h.internals.readVmReconcilePublicCoreTransportPreference(cg, '1', [core, older])).toBe(core);
    expect(h.internals.preferredSyncPeers.get(cg)).toBe(older);
    expect(h.internals.vmReconcileRotationState.size).toBe(0);
  });

  it('bounds its process-local map and clears it for graph lifecycle and shutdown', async () => {
    const h = await harness();
    for (let index = 0; index <= DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES; index += 1) expect(remember(h, `graph-${index}`)).toBe(true);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.size).toBe(DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has('graph-0')).toBe(false);
    expect(remember(h)).toBe(true);
    h.internals.clearVmReconcileRotationStateForContextGraph(cg);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
    h.internals.closeVmReconcileRotationState();
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.size).toBe(0);
    h.internals.openVmReconcileRotationState();
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.size).toBe(0);
  });

  it('clears all graph hints when a peer is rejected by the network', async () => {
    const h = await harness(); expect(remember(h)).toBe(true); expect(remember(h, 'other')).toBe(true);
    h.internals.clearNetworkRejectedPeerState(core);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.size).toBe(0);
  });

  it('preserves the verified hint and ordinal evidence across real queue-zero refusal with no wire work', async () => {
    const h = await harness(); await h.run();
    const preference = h.internals.vmReconcilePublicCoreTransportPreferences.get(cg);
    const wirePeers: string[] = [];
    const empty = () => ({ fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
      failedPeers: 0, failedPhases: 0, deferredBackpressure: 1, complete: false });
    h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async (peer, graph, uals) => {
      try {
        const result = await withGlobalSyncBackpressure({ policy: resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 }),
          ctx: createOperationContext('sync'), label: `durable:${graph}:${peer}`, lane: 'durable', source: 'vm-recovery', priority: 1000 }, async () => {
          wirePeers.push(peer);
          for (const ual of uals) h.recovered.add(h.targets.find((target) => target.ual === ual)!.ordinal);
          return { ...empty(), deferredBackpressure: 0, complete: true,
            fetchedDataTriples: uals.length, insertedTriples: uals.length };
        });
        return { disposition: 'found', result };
      } catch (error) {
        if (!getSyncBackpressureBusyError(error)) throw error;
        return { disposition: 'incomplete', result: empty() };
      }
    };
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const phonebook = withGlobalSyncBackpressure({ policy: resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 }),
      ctx: createOperationContext('sync'), label: 'durable:phonebook', lane: 'durable', source: 'sync-on-connect' }, async () => { entered(); await held; });
    await started;
    try {
      const refused = await next(h);
      expect(wirePeers).toEqual([]);
      expect(refused).toMatchObject({ attemptedOrdinals: [], localAdmissionDeferred: true, continuationOrdinal: 0 });
      expect(h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)).toBe(preference);
      const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
      expect([...record.attemptedPeerIds]).toEqual([older]);
      expect([...record.cleanAbsentPeerIds]).toEqual([older]);
      release(); await phonebook;
      const resumed = await next(h);
      expect(wirePeers).toEqual([core, core]);
      expect(resumed.attemptedOrdinals).toEqual([0, 3]);
    } finally { release(); await phonebook; }
  });
});

describe('experimental carried public Core holder', () => {
  it('yields after verified unknown-hint reuse without credit and finishes through ordinary fresh probes', async () => {
    vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '1');
    const h = await harness(0, undefined, [older, core, third]);
    vi.spyOn(h.agent, 'getPeerProtocols').mockResolvedValue([]);
    vi.spyOn(h.agent, 'readLiveOnChainAccessPolicy').mockRejectedValue(new Error('policy unavailable'));
    const first = await h.run();
    expect(h.fetched.map(({ peerId }) => peerId)).toEqual([older, core, core]);
    expect(first.attemptedOrdinals).toEqual([0, 1, 2]);
    expect(first.continuationOrdinal).toBe(3);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);

    const second = await next(h);
    expect(h.fetched.slice(3)).toEqual([
      { peerId: core, uals: [h.targets[0]!.ual] },
      { peerId: core, uals: [h.targets[3]!.ual] },
    ]);
    expect(second.continuationOrdinal).toBe(4);
    // With no preference, untouched targets still use the ordinary roster.
    const thirdSlice = await next(h);
    expect(h.fetched.slice(5).map(({ peerId }) => peerId)).toEqual([older, core, core]);
    expect(thirdSlice.attemptedOrdinals).toEqual([4, 5, 6]);
    await next(h);
    expect([...h.recovered].sort()).toEqual(h.targets.map(({ ordinal }) => ordinal));
    expect(h.fetched.filter(({ peerId }) => peerId === core).flatMap(({ uals }) => uals))
      .toEqual([1, 2, 0, 3, 5, 6, 4].map(ordinal => h.targets[ordinal]!.ual));
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
    expect(h.maxActiveFetches()).toBe(1);
  });

  it.each(['clean-absent', 'incomplete', 'unverified', 'throw'] as const)('does not yield after unknown-hint reuse returns %s', async failure => {
    vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '1');
    const h = await harness(0, (peer, ordinal) => {
      if (peer === core && ordinal === 2) {
        if (failure === 'throw') throw new Error('transport failure');
        return failure;
      }
      return peer === older ? 'clean-absent' : 'found';
    }, [older, core, third]);
    vi.spyOn(h.agent, 'getPeerProtocols').mockResolvedValue([]);
    vi.spyOn(h.agent, 'readLiveOnChainAccessPolicy').mockRejectedValue(new Error('policy unavailable'));
    const result = await h.run();
    expect(h.fetched.map(({ peerId }) => peerId)).toEqual([older, core, core, third, third]);
    expect(result.outcomes.get(2)?.status).toBe('pending');
    expect(result.continuationOrdinal).toBe(5);
    expect(h.recovered.has(2)).toBe(false);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
    expect(new Set(h.fetched.map(({ peerId }) => peerId)).size).toBe(DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX);
  });

  it('does not grant credit when renewal refuses a verified batch, and probes again next slice', async () => {
    vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '1');
    const h = await harness(0, undefined, [older, core, third], { targetCount: 35, knownSizing: true });
    vi.spyOn(h.agent, 'getPeerProtocols').mockResolvedValue([]);
    vi.spyOn(h.internals, 'rememberVmReconcilePublicCoreTransportPreference').mockReturnValue(false);
    const first = await h.run();
    expect(h.fetched.map(({ uals }) => uals.length)).toEqual([1, 1, 8]);
    expect(first.continuationOrdinal).toBe(10);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
    const second = await next(h);
    expect(h.fetched.slice(3).map(({ uals }) => uals.length)).toEqual([1, 8]);
    expect(h.fetched[3]).toEqual({ peerId: core, uals: [h.targets[0]!.ual] });
    expect(second.continuationOrdinal).toBe(18);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
  });

  it('keeps ordinary fallback for a verified peer without Core capability', async () => {
    vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '1');
    const h = await harness(0, undefined, [older, core, third]);
    h.internals.peerCapabilityRegistry.forget(core);
    vi.spyOn(h.agent, 'getPeerProtocols').mockResolvedValue([]);
    vi.spyOn(h.agent, 'readLiveOnChainAccessPolicy').mockRejectedValue(new Error('policy unavailable'));
    const result = await h.run();
    expect(h.fetched.map(({ peerId }) => peerId)).toEqual([older, core, core, third, third]);
    expect(result.continuationOrdinal).toBe(5);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
  });

  it('starts consecutive productive slices with one bounded ordinary batch and verifies every UAL', async () => {
    const h = await carriedHarness();
    expect(h.fetched.map(({ uals }) => uals.length)).toEqual([1, 1, 8]);
    const prior = h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)!;
    const reconcile = vi.spyOn(h.agent, 'reconcileChainOrdinal');
    const second = await next(h);
    const batch = [h.targets[0]!, ...h.targets.slice(10, 17)];
    expect(h.fetched.slice(3)).toEqual([{ peerId: core, uals: batch.map(({ ual }) => ual) }]);
    expect(reconcile.mock.calls.map((call) => call[2])).toEqual(batch.map(({ ordinal }) => ordinal));
    expect(second.attemptedOrdinals).toEqual(batch.map(({ ordinal }) => ordinal));
    expect(second.continuationOrdinal).toBe(17);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)?.token).not.toBe(prior.token);
    const untouched = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[17]!))!;
    expect([...untouched.candidatePeerIds]).toEqual([older, core, third]);
    expect(untouched.attemptedPeerIds.size).toBe(0);
    expect(untouched.cleanAbsentPeerIds.size).toBe(0);
    await next(h);
    expect(h.fetched.slice(4).map(({ uals }) => uals.length)).toEqual([8]);
    expect(h.maxActiveFetches()).toBe(1);
    expect(h.internals.preferredSyncPeers.get(cg)).toBe(older);
  });

  it('restores the singleton probe when the experimental flag is disabled', async () => {
    const h = await carriedHarness();
    vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '0');
    await next(h);
    expect(h.fetched.slice(3).map(({ uals }) => uals.length)).toEqual([1, 8]);
  });

  it('keeps unknown footprints singleton even with a carried holder', async () => {
    const h = await carriedHarness();
    vi.spyOn(h.chainAdapter, 'getKnowledgeAssetUpdateContext').mockRejectedValue(new Error('sizing unavailable'));
    await next(h);
    expect(h.fetched.slice(3).map(({ uals }) => uals.length)).toEqual([1]);
  });

  it('does not promote an ordering hint or Identify role into carried credit', async () => {
    vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '1');
    const h = await harness(0, undefined, [older, core, third], { targetCount: 35, knownSizing: true });
    vi.spyOn(h.agent, 'getPeerProtocols').mockResolvedValue([]);
    expect(remember(h)).toBe(true);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)?.holderCredit).toBeUndefined();
    await h.run();
    expect(h.fetched.map(({ uals }) => uals.length)).toEqual([1, 8]);
  });

  it.each(['binding', 'binding-generation', 'selected-binding', 'deployment', 'lifecycle',
    'expiry', 'reconnect', 'role', 'roster', 'graph-clear'] as const)('invalidates %s before a carried batch', async change => {
    const h = await carriedHarness();
    const prior = h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)!;
    if (change === 'binding') prior.onChainCgId = '2';
    if (change === 'binding-generation') h.internals.contextGraphBindingState.bump(cg);
    if (change === 'selected-binding') vi.spyOn(h.internals.selectedVmReconcileCursors, 'get').mockReturnValue({ bindingGeneration: 99 });
    if (change === 'deployment') vi.spyOn(h.chainAdapter, 'deploymentId', 'get').mockReturnValue('mock:replacement');
    if (change === 'lifecycle') h.internals.vmReconcileLifecycleGeneration += 1;
    if (change === 'expiry') h.internals.vmReconcileRotationNow = () => prior.expiresAt + 1;
    if (change === 'reconnect') h.internals.node.libp2p.getConnections = () => [older, core, third]
      .map(peerId => ({ remotePeer: { toString: () => peerId }, timeline: { open: 99 } }));
    if (change === 'role') h.internals.peerCapabilityRegistry.forget(core);
    if (change === 'roster') h.internals.node.libp2p.getConnections = () => [older, core, third, '12D3KooWNewRoster']
      .map(peerId => ({ remotePeer: { toString: () => peerId } }));
    if (change === 'graph-clear') h.internals.clearVmReconcileRotationStateForContextGraph(cg);
    await next(h);
    expect(h.fetched[3]!.uals).toHaveLength(1);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)?.token).not.toBe(prior.token);
  });

  it.each(['disconnect', 'protocol', 'admission'] as const)('revokes %s failure without falsely crediting presence', async change => {
    const h = await carriedHarness();
    if (change === 'disconnect') h.internals.node.libp2p.getConnections = () => [older, third]
      .map(peerId => ({ remotePeer: { toString: () => peerId } }));
    if (change === 'protocol') h.internals.waitForSyncProtocol = async peer => peer.toString() !== core;
    if (change === 'admission') h.internals.ensurePeerAdmittedForRecovery = async peer => peer !== core;
    await next(h);
    expect(h.fetched.slice(3).every(({ peerId }) => peerId !== core)).toBe(true);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
  });

  it.each(['partial', 'clean-absent', 'incomplete', 'throw'] as const)('revokes %s outcomes and keeps the original provider cap', async failure => {
    let fail = false;
    const h = await carriedHarness(peer => {
      if (!fail) return peer === older ? 'clean-absent' : 'found';
      if (peer !== core || failure === 'partial') return 'found';
      if (failure === 'throw') throw new Error('transport failure');
      return failure;
    }, [older, core, third, '12D3KooWZZZZFourth']);
    fail = true;
    const reconcile = h.internals.reconcileChainOrdinal;
    h.internals.reconcileChainOrdinal = async (...args) => failure === 'partial' && args[2] === 10
      ? { status: 'pending', recovery: h.targets[10]! }
      : reconcile(...args);
    const second = await next(h);
    expect(h.fetched[3]!.uals).toHaveLength(8);
    expect(h.fetched.slice(4).every(({ peerId }) => peerId !== core)).toBe(true);
    expect(new Set(h.fetched.slice(3).map(({ peerId }) => peerId)).size).toBeLessThanOrEqual(DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
    if (failure === 'partial') expect(second.outcomes.get(10)?.status).toBe('pending');
  });

  it.each(['private', 'unavailable'] as const)('revokes credit when public sizing authority is %s', async change => {
    const h = await carriedHarness();
    const policy = vi.spyOn(h.agent, 'readLiveOnChainAccessPolicy');
    if (change === 'private') policy.mockResolvedValue(1);
    else policy.mockRejectedValue(new Error('policy unavailable'));
    const second = await next(h);
    expect(h.fetched.slice(3)).toEqual([{ peerId: core, uals: [h.targets[0]!.ual] }]);
    expect(second.attemptedOrdinals).toEqual([0]);
    expect(second.continuationOrdinal).toBe(10);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
    const thirdSlice = await next(h);
    expect(h.fetched.slice(4)).toEqual([
      { peerId: older, uals: [h.targets[10]!.ual] },
      { peerId: core, uals: [h.targets[11]!.ual] },
      { peerId: core, uals: [h.targets[12]!.ual] },
    ]);
    expect(thirdSlice.continuationOrdinal).toBe(13);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
  });

  it.each(['expiry', 'reconnect', 'binding', 'entry-replacement'] as const)('rechecks %s after sizing without sending an old carried batch', async change => {
    const h = await carriedHarness();
    const prior = h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)!;
    const replacement = { ...prior, token: Symbol('replacement') };
    const read = h.chainAdapter.getKnowledgeAssetUpdateContext.bind(h.chainAdapter);
    let changed = false;
    vi.spyOn(h.chainAdapter, 'getKnowledgeAssetUpdateContext').mockImplementation(async (...args) => {
      if (!changed) {
        changed = true;
        if (change === 'expiry') h.internals.vmReconcileRotationNow = () => prior.expiresAt + 1;
        if (change === 'binding') h.internals.contextGraphBindingState.bump(cg);
        if (change === 'reconnect') h.internals.node.libp2p.getConnections = () => [older, core, third]
          .map(peerId => ({ remotePeer: { toString: () => peerId }, timeline: { open: 99 } }));
        if (change === 'entry-replacement') h.internals.vmReconcilePublicCoreTransportPreferences.set(cg, replacement);
      }
      return read(...args);
    });
    const second = await next(h);
    expect(h.fetched).toHaveLength(3);
    expect(second).toMatchObject({ attemptedOrdinals: [], continuationOrdinal: 0, hasImmediateRecoveryWork: true });
    if (change === 'entry-replacement') expect(h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)).toBe(replacement);
    else expect(h.internals.vmReconcilePublicCoreTransportPreferences.has(cg)).toBe(false);
  });

  it.each(['found', 'incomplete'] as const)('does not let an old %s completion replace or revoke a newer entry', async disposition => {
    let fail = false;
    const h = await carriedHarness(peer => !fail ? (peer === older ? 'clean-absent' : 'found') : peer === core ? disposition : 'found');
    fail = true;
    const prior = h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)!;
    const replacement = { ...prior, token: Symbol('replacement') };
    const execute = h.internals.executeVmRecoveryBatch.bind(h.internals);
    h.internals.executeVmRecoveryBatch = async input => {
      const result = await execute(input);
      if (input.peerId === core) h.internals.vmReconcilePublicCoreTransportPreferences.set(cg, replacement);
      return result;
    };
    await next(h);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)).toBe(replacement);
  });

  it('retains the unconsumed credit across zero-work local refusal and retries one batch', async () => {
    const h = await carriedHarness();
    const prior = h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)!;
    const fetch = h.internals.syncExactKnowledgeAssetsFromPeerDetailed;
    h.internals.syncExactKnowledgeAssetsFromPeerDetailed = vi.fn(async () => ({ disposition: 'incomplete' as const, result: {
      fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
      failedPeers: 0, failedPhases: 0, deferredBackpressure: 1,
    } }));
    const refused = await next(h);
    expect(refused).toMatchObject({ attemptedOrdinals: [], localAdmissionDeferred: true });
    expect(h.fetched).toHaveLength(3);
    expect(h.internals.vmReconcilePublicCoreTransportPreferences.get(cg)).toBe(prior);
    const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
    expect([...record.attemptedPeerIds]).toEqual([older]);
    expect([...record.cleanAbsentPeerIds]).toEqual([older]);
    h.internals.syncExactKnowledgeAssetsFromPeerDetailed = fetch;
    await next(h);
    expect(h.fetched.slice(3).map(({ uals }) => uals.length)).toEqual([8]);
  });
});
