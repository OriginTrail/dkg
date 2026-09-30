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

async function harness(accessPolicy: 0 | 1 = 0, behavior?: (peer: string, ordinal: number) => 'found' | 'clean-absent' | 'incomplete' | 'unverified', peers = [older, core]) {
  const h = await createVmRecoveryHostHarness({
    name: 'VmCoreTransportPreference', localCgId: cg, peers,
    targetCount: 7, sizingUnavailable: true, accessPolicy,
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
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(agents.splice(0).map((agent) => agent.stop())); });

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
