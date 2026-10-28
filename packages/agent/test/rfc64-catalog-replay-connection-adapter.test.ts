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
      peerId, generation: 1, admit: vi.fn(), release: vi.fn(),
    }));
    const scheduled = new Map<0 | 1 | 'deadline', (signal: AbortSignal) => Promise<void>>();
    const controller = new AbortController();
    const runtime = createRfc64CatalogReplayConnectionRuntimeV1({
      reserveDeferred: () => null,
      admittedConnectedPeerIds: () => [],
      reannounce: announce,
      capabilities: {
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
    expect(readAcceptedPolicy).toHaveBeenCalledTimes(2);
    expect(accepted.policyDigest).not.toBe(initialDigest);
    accepted = null;
    const unavailable = runtime.prepareConnectionOpen('unknown')!;
    expect(reservePeer).toHaveBeenCalledOnce();
    unavailable.reject(); runtime.reset();
  });
});


