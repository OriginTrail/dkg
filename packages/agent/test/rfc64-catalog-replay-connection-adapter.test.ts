import {RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1} from '../src/rfc64/public-catalog-transport-v1.js';
import {createRfc64CatalogReplayConnectionRuntimeV1} from '../src/rfc64/catalog-replay-connection-adapter-v1.js';
import {buildOpenOwnerContextGraphPolicyV1, computeOpenContextGraphPolicyDigestV1} from '../src/rfc64/open-catalog-policy-v1.js';
import {RFC64_ROLLOUT_AUTHOR, RFC64_ROLLOUT_CONTEXT_GRAPH_ID, RFC64_ROLLOUT_NETWORK_ID} from './_helpers/rfc64-rollout-agent-harness.js';

import {describe, expect, it, vi} from 'vitest';





describe('connection adapter current-policy capabilities', () => {
  it('uses separate reservation and announcement snapshots without an agent dependency', async () => {
    const initial = buildOpenOwnerContextGraphPolicyV1({ networkId: RFC64_ROLLOUT_NETWORK_ID,
      contextGraphId: RFC64_ROLLOUT_CONTEXT_GRAPH_ID, ownerAddress: RFC64_ROLLOUT_AUTHOR });
    const successor = Object.freeze({ ...initial, issuedAt: '1' as typeof initial.issuedAt });
    const snapshot = (policy: typeof initial) => Object.freeze({ policy,
      policyDigest: computeOpenContextGraphPolicyDigestV1(policy), roster: null });
    let accepted: ReturnType<typeof snapshot> | null = snapshot(initial);
    const initialDigest = accepted.policyDigest;
    const readAcceptedPolicy = vi.fn(() => accepted);
    const announce = vi.fn(async () => ({ failed: 0 }));
    const reservePeer = vi.fn((_cg: string, _digest: string, peerId: string) => ({
      peerId, generation: 1, handle: {}, isCurrent: () => true, admit: vi.fn(), release: vi.fn(),
    }));
    const scheduled = new Map<0 | 1 | 'deadline', (signal: AbortSignal) => Promise<void>>();
    const controller = new AbortController();
    const runtime = createRfc64CatalogReplayConnectionRuntimeV1({
      reserveDeferred: () => null,
      admittedConnectedPeerIds: () => [],
      reannounce: announce,
      capabilities: {
        resolveRfc64CatalogReplayRolesV1: () => ({ receiving: true, serving: true }),
        listServingRfc64CatalogReplayContextGraphIdsV1: () => [RFC64_ROLLOUT_CONTEXT_GRAPH_ID],
        listActiveRfc64CatalogReplayContextGraphIdsV1: () => [RFC64_ROLLOUT_CONTEXT_GRAPH_ID],
        readAcceptedRfc64CatalogAccessSnapshotV1: readAcceptedPolicy,
      },
      reservePeer, replay: async () => ({ failed: 0 }), warn: vi.fn(),
      schedule: (slot, work) => { scheduled.set(slot, work); return true; }, wait: async () => undefined,
    });
    runtime.prepareConnectionOpen('peer')!.admit();
    expect(reservePeer).toHaveBeenCalledWith(RFC64_ROLLOUT_CONTEXT_GRAPH_ID, initialDigest, 'peer');
    accepted = snapshot(successor);
    await scheduled.get(0)!(controller.signal);
    expect(announce).toHaveBeenCalledExactlyOnceWith('peer', {
      kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1, networkId: RFC64_ROLLOUT_NETWORK_ID,
      contextGraphId: RFC64_ROLLOUT_CONTEXT_GRAPH_ID, policyDigest: accepted.policyDigest,
    }, controller.signal);
    expect(reservePeer).toHaveBeenLastCalledWith(RFC64_ROLLOUT_CONTEXT_GRAPH_ID, accepted.policyDigest, 'peer');
    expect(accepted.policyDigest).not.toBe(initialDigest);
    accepted = null;
    const unavailable = runtime.prepareConnectionOpen('unknown')!;
    expect(reservePeer).toHaveBeenCalledTimes(2);
    unavailable.reject(); runtime.reset();
  });
});



it('uses point authority checks for a large initial selection', () => {
  const graphs = Array.from({ length: 257 }, (_, i) => `cg-${i}`);
  const authority = vi.fn((_id: string) => ({ receiving: true, serving: true }));
  const list = vi.fn(() => { for (const id of graphs) authority(id); return graphs; });
  const runtime = createRfc64CatalogReplayConnectionRuntimeV1({
    capabilities: { listActiveRfc64CatalogReplayContextGraphIdsV1: list,
      listServingRfc64CatalogReplayContextGraphIdsV1: () => [],
      resolveRfc64CatalogReplayRolesV1: authority,
      readAcceptedRfc64CatalogAccessSnapshotV1: () => ({ policyDigest: 'p' }) as never },
    admittedConnectedPeerIds: () => [], reserveDeferred: () => ({ release() {} }),
    reservePeer: (_cg, _digest, peerId) => ({ peerId, generation: 1, handle: {}, isCurrent: () => true, admit() {}, release() {} }),
    reannounce: async () => ({ failed: 0 }), replay: async () => ({ failed: 0 }),
    schedule: () => true, wait: async () => {}, warn: vi.fn(),
  });
  runtime.prepareConnectionOpen('peer')!.admit();
  expect(list).toHaveBeenCalledOnce();
  expect(authority.mock.calls.length).toBeLessThanOrEqual(graphs.length * 3);
  expect(authority.mock.calls.length).toBeGreaterThanOrEqual(graphs.length * 2);
  runtime.reset();
});

it.each(['before-admission', 'cooldown', 'during-announcement', 'clear', 'reset', 'capacity'] as const)
  ('renews retired recovery custody at execution after %s', async timing => {
    const { Rfc64CatalogReplayRecoveryRuntimeV1 } = await import('../src/rfc64/catalog-replay-recovery-runtime-v1.js');
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const initial = buildOpenOwnerContextGraphPolicyV1({ networkId: RFC64_ROLLOUT_NETWORK_ID,
      contextGraphId: RFC64_ROLLOUT_CONTEXT_GRAPH_ID, ownerAddress: RFC64_ROLLOUT_AUTHOR });
    const snapshot = (policy: typeof initial) => ({ policy, policyDigest: computeOpenContextGraphPolicyDigestV1(policy), roster: null });
    let accepted = snapshot(initial), head = 'H1';
    const successor = snapshot({ ...initial, issuedAt: '1' as typeof initial.issuedAt });
    const cg = RFC64_ROLLOUT_CONTEXT_GRAPH_ID;
    const requested: string[] = [];
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<string>({
      requestPeer: async (_cg, peer) => { requested.push(peer); return { status: 'completed', targets: [head] }; },
      whenReceiverIdleForContextGraph: async () => {}, targetIdentity: value => value, parityFailed: async () => false,
    });
    const scheduled = new Map<0 | 1 | 'deadline', (signal: AbortSignal) => Promise<void>>();
    const held = Promise.withResolvers<void>(), announcing = Promise.withResolvers<void>();
    const signal = new AbortController().signal;
    const reserved: string[] = [];
    let capacityBlocked = false;
    const connection = createRfc64CatalogReplayConnectionRuntimeV1({
      capabilities: {
        resolveRfc64CatalogReplayRolesV1: () => ({ receiving: true, serving: true }),
        listActiveRfc64CatalogReplayContextGraphIdsV1: () => [cg], listServingRfc64CatalogReplayContextGraphIdsV1: () => [cg],
        readAcceptedRfc64CatalogAccessSnapshotV1: () => accepted,
      }, admittedConnectedPeerIds: () => ['peer'],
      reservePeer: (id, policy, peer) => { reserved.push(policy); return capacityBlocked ? null : recovery.reservePeer(id, policy, peer); },
      reserveDeferred: id => recovery.reserveDeferred(id, accepted.policyDigest),
      reannounce: async () => { if (timing === 'during-announcement') { announcing.resolve(); await held.promise; } return { failed: 0 }; },
      replay: (id, demand, owner) => recovery.request({ contextGraphId: id, policyDigest: accepted.policyDigest, kind: 'connection-demand', demand, signal: owner }),
      schedule: (slot, work) => { scheduled.set(slot, work); return true; }, wait: async () => {}, warn: vi.fn(),
    });
    try {
      if (timing === 'cooldown') {
        connection.prepareConnectionOpen('peer')!.admit(); await scheduled.get(0)!(signal);
        expect(requested).toEqual(['peer']);
        connection.disconnected('peer'); vi.setSystemTime(11_000);
      }
      const reservation = connection.prepareConnectionOpen('peer')!;
      if (timing !== 'before-admission') reservation.admit();
      const running = timing === 'during-announcement' ? scheduled.get(0)!(signal) : undefined;
      if (running) await announcing.promise;
      head = 'H2';
      capacityBlocked = timing === 'capacity';
      if (timing === 'clear') recovery.clear(cg);
      else if (timing === 'reset') recovery.reset();
      else accepted = successor;
      if (timing === 'before-admission') reservation.admit();
      if (timing === 'cooldown') {
        await scheduled.get(0)!(signal); expect(requested).toHaveLength(1);
        vi.setSystemTime(70_000);
      }
      if (timing === 'capacity') {
        await scheduled.get(0)!(signal);
        expect(requested).toHaveLength(0);
        expect(connection.status().pendingScopes).toBe(1);
        expect(recovery.status(cg, accepted.policyDigest)?.active).toBe(true);
        capacityBlocked = false;
      }
      held.resolve();
      if (running) await running; else await scheduled.get(0)!(signal);
      expect(requested).toHaveLength(timing === 'cooldown' ? 2 : 1);
      expect(reserved.at(-1)).toBe(accepted.policyDigest);
      expect(recovery.promisedTargets(cg, accepted.policyDigest)).toContain('H2');
      expect(recovery.status(cg, accepted.policyDigest)?.active).toBe(false);
      expect(connection.status().pendingScopes).toBe(0);
    } finally { held.resolve(); connection.reset(); vi.useRealTimers(); }
  });
