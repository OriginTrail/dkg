// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type Digest32V1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 } from '../src/rfc64/catalog-peers-v1.js';
import {
  Rfc64CatalogReplayRecoveryRuntimeV1,
  type Rfc64CatalogReplayPeerResultV1,
} from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';
import { computeRfc64AppliedInventoryDigestV1 } from
  '../src/rfc64/public-catalog-inventory-completeness-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
  Rfc64PublicCatalogTransportErrorV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from '../src/rfc64/public-catalog-transport-v1.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_AUTHOR as AUTHOR,
  RFC64_ROLLOUT_AUTHOR_WALLET as AUTHOR_WALLET,
  RFC64_ROLLOUT_CONTEXT_GRAPH_ID as CONTEXT_GRAPH_ID,
  RFC64_ROLLOUT_DEPLOYMENT as DEPLOYMENT,
  RFC64_ROLLOUT_NETWORK_ID as NETWORK_ID,
  rfc64RolloutActivation as activation,
} from './_helpers/rfc64-rollout-agent-harness.js';

interface Target {
  readonly id: string;
}

const CG = 'public-cg';
const POLICY = 'policy';
const FAILING_PEER = 'peer-unreachable';
const HEALTHY_PEER = 'peer-healthy';

const completed = (targets: readonly Target[] = []) => Object.freeze({
  status: 'completed' as const,
  targets: Object.freeze([...targets]),
});

function createRuntime(overrides: {
  readonly requestPeer?: (contextGraphId: string, peerId: string) => Promise<
    Rfc64CatalogReplayPeerResultV1<Target>
  >;
  readonly whenReceiverIdleForContextGraph?: (contextGraphId: string) => Promise<void>;
  readonly parityFailed?: () => Promise<boolean>;
} = {}) {
  const requestPeer = vi.fn(overrides.requestPeer ?? (async (_cg: string, peerId: string) => {
    if (peerId === FAILING_PEER) throw new Error('provider unreachable');
    return completed();
  }));
  const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
    requestPeer,
    whenReceiverIdleForContextGraph:
      overrides.whenReceiverIdleForContextGraph ?? (async () => undefined),
    targetIdentity: (target) => target.id,
    parityFailed: overrides.parityFailed ?? (async () => false),
  });
  return { runtime, requestPeer };
}

function fullRun(
  runtime: Rfc64CatalogReplayRecoveryRuntimeV1<Target>,
  connectedPeerIds: readonly string[],
) {
  return runtime.request({
    contextGraphId: CG,
    policyDigest: POLICY,
    kind: 'full-connected-peers',
    connectedPeerIds,
  });
}

function scopedRun(runtime: Rfc64CatalogReplayRecoveryRuntimeV1<Target>) {
  return runtime.request({ contextGraphId: CG, policyDigest: POLICY, kind: 'pending-recovery' });
}

function requestedPeers(requestPeer: { mock: { calls: readonly (readonly unknown[])[] } }) {
  return requestPeer.mock.calls.map(([, peerId]) => peerId);
}

describe('RFC-64 catalog replay recovery: provider failure reporting', () => {
  it('reports one unreachable provider without failing the Context Graph and keeps retrying it', async () => {
    const { runtime, requestPeer } = createRuntime();

    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 1,
      unverified: false,
    });

    // The retained provider is re-seeded by the next scoped request (two dial attempts).
    requestPeer.mockClear();
    await expect(scopedRun(runtime)).resolves.toEqual({ requested: 0, failed: 1 });
    expect(requestedPeers(requestPeer)).toEqual([FAILING_PEER, FAILING_PEER]);
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 1,
      unverified: false,
    });

    // Attribution clears only when a replay from that exact provider succeeds.
    requestPeer.mockImplementation(async () => completed());
    await expect(scopedRun(runtime)).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 0,
      unverified: false,
    });
  });

  it('still fails the Context Graph on a parity failure', async () => {
    const { runtime } = createRuntime({
      requestPeer: async () => completed([{ id: 'promised-head' }]),
      parityFailed: async () => true,
    });

    await expect(fullRun(runtime, [HEALTHY_PEER])).resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: true,
      unresolvedPeerCount: 0,
      unverified: false,
    });
  });

  it('still fails the Context Graph when the bounded worklist overflows', async () => {
    const churnPeer = 'peer-reconnect-churn';
    let runtime!: Rfc64CatalogReplayRecoveryRuntimeV1<Target>;
    const created = createRuntime({
      requestPeer: async () => completed(),
      whenReceiverIdleForContextGraph: async () => {
        runtime.markPeerPending(CG, POLICY, churnPeer);
      },
    });
    runtime = created.runtime;

    await expect(fullRun(runtime, [churnPeer])).resolves.toEqual({
      requested: RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1,
      failed: 1,
    });
    expect(created.requestPeer).toHaveBeenCalledTimes(RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1);
    expect(runtime.status(CG, POLICY)).toMatchObject({
      failed: true,
      unresolvedPeerCount: 0,
      unverified: false,
    });
  });

  it('drops a retained provider once a connected-peer run shows it disconnected', async () => {
    const { runtime, requestPeer } = createRuntime();

    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status(CG, POLICY)?.unresolvedPeerCount).toBe(1);

    // A scoped run carries no connectivity evidence: the provider is retried.
    requestPeer.mockClear();
    await expect(scopedRun(runtime)).resolves.toEqual({ requested: 0, failed: 1 });
    expect(requestedPeers(requestPeer)).toEqual([FAILING_PEER, FAILING_PEER]);
    expect(runtime.status(CG, POLICY)?.unresolvedPeerCount).toBe(1);

    // A connected-peer run that no longer lists the provider drops it unrequested.
    requestPeer.mockClear();
    const before = runtime.revision;
    await expect(fullRun(runtime, [HEALTHY_PEER])).resolves.toEqual({ requested: 1, failed: 0 });
    expect(requestedPeers(requestPeer)).toEqual([HEALTHY_PEER]);
    // A run follows, so its own two bumps (start and settle) already publish the
    // drop: a third bump would only cost every racing status read a durable
    // applied-head re-read and a transient all-null parity projection. The case
    // where the drop's bump is the ONLY one is covered by the next test.
    expect(runtime.revision - before).toBe(2);
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 0,
      unverified: false,
    });
  });

  it('bumps the revision for a drop that starts no run, so the status re-read is not skipped', async () => {
    const { runtime, requestPeer } = createRuntime();

    await expect(fullRun(runtime, [FAILING_PEER])).resolves.toEqual({ requested: 0, failed: 1 });
    expect(runtime.status(CG, POLICY)?.unresolvedPeerCount).toBe(1);

    // Every peer is gone. The drop empties `unresolvedPeers`, nothing is left pending,
    // and `request()` returns before it reaches its unconditional bump -- so the drop's
    // own bump is the only one. Without it, `readRfc64CatalogOperationalStatusV1` sees an
    // unchanged revision across a real state transition and skips the applied-head re-read.
    requestPeer.mockClear();
    const before = runtime.revision;
    await expect(fullRun(runtime, [])).resolves.toEqual({ requested: 0, failed: 0 });
    expect(requestedPeers(requestPeer)).toEqual([]);
    expect(runtime.revision).toBeGreaterThan(before);
    expect(runtime.status(CG, POLICY)?.unresolvedPeerCount).toBe(0);
  });

  it('clears a parity witness on a corroborated pass even while an unreplayable provider stays connected', async () => {
    let parityFails = true;
    const { runtime } = createRuntime({
      requestPeer: async (_cg, peerId) => {
        if (peerId === FAILING_PEER) throw new Error('provider unreachable');
        return completed([{ id: 'promised-head' }]);
      },
      parityFailed: async () => parityFails,
    });

    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 2 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: true,
      unresolvedPeerCount: 1,
      unverified: false,
    });

    // A provider that never answers is attributed and retried; it cannot keep a
    // parity witness alive once a clean pass corroborated this node's applied rows.
    parityFails = false;
    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 1,
      unverified: false,
    });

    // Once it is gone from the connected set, one clean full pass settles the CG.
    await expect(fullRun(runtime, [HEALTHY_PEER])).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 0,
      unverified: false,
    });
  });

  it('does not manufacture a full-replay witness when a retained provider is retried past the seed bound', async () => {
    const { runtime } = createRuntime();

    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status(CG, POLICY)?.unresolvedPeerCount).toBe(1);

    // The retained provider is still connected but sits outside the seeded
    // window, so its retry must be deferred -- never counted as overflow.
    await fullRun(runtime, [
      ...Array.from(
        { length: RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 },
        (_unused, index) => `peer-healthy-${index}`,
      ),
      FAILING_PEER,
    ]);
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 1,
      unverified: false,
    });
  });

  it('does not let a later scoped run consume a full-replay request that started no run', async () => {
    let parityFails = true;
    const { runtime } = createRuntime({
      requestPeer: async (_cg, peerId) => {
        if (peerId === FAILING_PEER) throw new Error('provider unreachable');
        return completed([{ id: 'promised-head' }]);
      },
      parityFailed: async () => parityFails,
    });

    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 2 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: true,
      unresolvedPeerCount: 1,
      unverified: false,
    });

    // The drop empties `unresolvedPeers` and nothing is pending, so this full
    // request starts no run: its consent must not outlive the request.
    parityFails = false;
    await expect(fullRun(runtime, [])).resolves.toEqual({ requested: 0, failed: 0 });

    // One healthy peer is no full pass, so it may not clear the parity witness.
    await runtime.request({
      contextGraphId: CG,
      policyDigest: POLICY,
      kind: 'connection-demand',
      demand: { peerId: HEALTHY_PEER, generation: 1 },
    });
    expect(runtime.status(CG, POLICY)?.failed).toBe(true);
  });

  it('keeps a parity witness when no provider answered the full pass', async () => {
    let parityFails = true;
    let answer: (peerId: string) => Rfc64CatalogReplayPeerResultV1<Target> = () => (
      completed([{ id: 'promised-head' }])
    );
    const { runtime } = createRuntime({
      requestPeer: async (_cg, peerId) => answer(peerId),
      parityFailed: async () => parityFails,
    });

    await expect(fullRun(runtime, [HEALTHY_PEER])).resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status(CG, POLICY)?.failed).toBe(true);

    // Every peer denies the Context Graph: the pass corroborates nothing, so it
    // cannot vacuously clear a witness even though it attributed no failure.
    parityFails = false;
    answer = () => Object.freeze({ status: 'not-provider' as const });
    await expect(fullRun(runtime, [HEALTHY_PEER])).resolves.toEqual({ requested: 0, failed: 0 });
    expect(runtime.status(CG, POLICY)?.failed).toBe(true);
  });

  it('settles a full pass that reached no provider as uncorroborated, not clean', async () => {
    const { runtime } = createRuntime({
      requestPeer: async () => { throw new Error('provider unreachable'); },
    });

    // Every provider replay fails, so the promised set is empty and the parity
    // predicate is vacuously satisfied. Nothing was verified, which is not the
    // same claim as "every provider agrees".
    await expect(fullRun(runtime, [FAILING_PEER, 'peer-also-unreachable']))
      .resolves.toEqual({ requested: 0, failed: 2 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 2,
      unverified: true,
    });

    // One answered replay corroborates the applied rows again.
    const { runtime: recovered } = createRuntime();
    await expect(fullRun(recovered, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 1 });
    expect(recovered.status(CG, POLICY)?.unverified).toBe(false);
  });

  it('does not raise the uncorroborated state when every peer denies the Context Graph', async () => {
    const { runtime } = createRuntime({
      requestPeer: async () => Object.freeze({ status: 'not-provider' as const }),
    });

    // A policy-denied answer is an authoritative negative from a reachable
    // peer, not absence of evidence.
    await expect(fullRun(runtime, [HEALTHY_PEER])).resolves.toEqual({ requested: 0, failed: 0 });
    expect(runtime.status(CG, POLICY)?.unverified).toBe(false);
  });

  it('does not attribute a local precondition failure to the provider', async () => {
    let localFault = false;
    const { runtime } = createRuntime({
      requestPeer: async (_cg, peerId) => {
        if (localFault) return Object.freeze({ status: 'local-unavailable' as const });
        if (peerId === FAILING_PEER) throw new Error('provider unreachable');
        return completed();
      },
    });

    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status(CG, POLICY)?.unresolvedPeerCount).toBe(1);

    // A local fault neither attributes a new provider nor clears a retained one.
    localFault = true;
    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 0, failed: 2 });
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 1,
      unverified: false,
    });
  });

  it('rejects an invalid connected-peer list before it drops provider attribution', async () => {
    const { runtime } = createRuntime();

    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 1 });
    const before = runtime.revision;

    // The command is rejected, so it may not have already discarded the
    // retained provider (nor moved the revision) on its way out.
    expect(() => fullRun(runtime, [HEALTHY_PEER, HEALTHY_PEER])).toThrow(TypeError);
    expect(runtime.status(CG, POLICY)?.unresolvedPeerCount).toBe(1);
    expect(runtime.revision).toBe(before);
  });

  it('dials a retained provider that sits past the connected-peer truncation bound', async () => {
    const { runtime, requestPeer } = createRuntime();

    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 1 });

    // The drop reads the untruncated connected set and keeps this provider, so
    // the seed order has to reach it as well -- otherwise it is kept forever
    // and never dialed again.
    requestPeer.mockClear();
    await fullRun(runtime, [
      ...Array.from(
        { length: RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 },
        (_unused, index) => `peer-healthy-${index}`,
      ),
      FAILING_PEER,
    ]);
    expect(requestedPeers(requestPeer)).toContain(FAILING_PEER);
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 1,
      unverified: false,
    });
  });

  it('releases a dropped provider from the worklist so it is not dialed again', async () => {
    const { runtime, requestPeer } = createRuntime();

    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 1 });

    // An unsettled reconnect fence leaves the provider queued in the worklist.
    expect(runtime.markPeerPending(CG, POLICY, FAILING_PEER)).not.toBeNull();

    requestPeer.mockClear();
    await expect(fullRun(runtime, [HEALTHY_PEER])).resolves.toEqual({ requested: 1, failed: 0 });
    expect(requestedPeers(requestPeer)).toEqual([HEALTHY_PEER]);
    expect(runtime.status(CG, POLICY)?.unresolvedPeerCount).toBe(0);
  });

  it('stops re-seeding a retained provider once its bounded retry budget is spent', async () => {
    const { runtime, requestPeer } = createRuntime();

    await expect(fullRun(runtime, [FAILING_PEER, HEALTHY_PEER]))
      .resolves.toEqual({ requested: 1, failed: 1 });
    for (let retry = 0; retry < 3; retry += 1) {
      await expect(scopedRun(runtime)).resolves.toEqual({ requested: 0, failed: 1 });
    }

    // Ambient runs stop spending their demand budget on a dead dial...
    requestPeer.mockClear();
    await expect(scopedRun(runtime)).resolves.toEqual({ requested: 0, failed: 0 });
    expect(requestedPeers(requestPeer)).toEqual([]);
    // ...while the attribution stays reported.
    expect(runtime.status(CG, POLICY)?.unresolvedPeerCount).toBe(1);

    // Its own reconnect still raises a fresh demand, which is seeded directly.
    requestPeer.mockClear();
    await runtime.request({
      contextGraphId: CG,
      policyDigest: POLICY,
      kind: 'connection-demand',
      demand: { peerId: FAILING_PEER, generation: 1 },
    });
    expect(requestedPeers(requestPeer)).toEqual([FAILING_PEER, FAILING_PEER]);
  });

  it('reserves connected-peer worklist slots when the attribution set is saturated', async () => {
    const deadPeers = Array.from(
      { length: RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 },
      (_unused, index) => `peer-dead-${index}`,
    );
    const { runtime, requestPeer } = createRuntime({
      requestPeer: async (_cg, peerId) => {
        if (peerId === HEALTHY_PEER) return completed();
        throw new Error('provider unreachable');
      },
    });

    // Saturate attribution: every provider in the pass fails, so all 64 slots
    // of `unresolvedPeers` are held by peers that are still connected.
    await fullRun(runtime, deadPeers);
    expect(runtime.status(CG, POLICY)).toMatchObject({
      unresolvedPeerCount: RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1,
      unverified: true,
    });

    // Retained retries may not take the whole worklist: a live provider in the
    // pass's own connected set must still be dialed, or `requested` is 0 on
    // every run and the Context Graph can never re-corroborate.
    requestPeer.mockClear();
    await expect(fullRun(runtime, [HEALTHY_PEER, ...deadPeers]))
      .resolves.toMatchObject({ requested: 1 });
    expect(requestedPeers(requestPeer)).toContain(HEALTHY_PEER);
    expect(runtime.status(CG, POLICY)?.unverified).toBe(false);
  });

  it('raises the uncorroborated state on a connected-peer pass that could not cover every peer', async () => {
    // The RAISE must not share the CLEAR's gate. `requestedFullReplay` is set
    // only when a pass queued EVERY connected peer, so it encodes the right to
    // CLEAR a witness. Gating the raise on it withholds the DUTY to raise one in
    // the case that most deserves it: a connected-peer pass that could not cover
    // every peer AND had every dial fail has `requested === 0`, no overflow
    // (`seedBounded` defers) and `#pending <= 64`, so nothing else raises either.
    // The Context Graph would settle corroborated having reached no provider.
    const deadPeers = Array.from({ length: 40 }, (_unused, index) => `peer-dead-${index}`);
    // Enough fresh peers to fill the truncation window on their own, so the
    // retained seeds consume slots the connected fill then cannot use.
    const otherPeers = Array.from(
      { length: RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 },
      (_unused, index) => `peer-other-${index}`,
    );
    const { runtime } = createRuntime({
      requestPeer: async (_cg, peerId) => {
        if (peerId === HEALTHY_PEER) return completed();
        throw new Error('provider unreachable');
      },
    });

    // One answered replay clears `unverified` while leaving 40 peers retained,
    // so the discriminating pass starts from a CLEAN state, not a witnessed one.
    await fullRun(runtime, [HEALTHY_PEER, ...deadPeers]);
    expect(runtime.status(CG, POLICY)).toMatchObject({
      unverified: false,
      unresolvedPeerCount: deadPeers.length,
    });

    // The retained peers sit OUTSIDE the truncation window (`connectedPeerIds`
    // is sliced to the announce bound before the coverage loop), so the slots
    // they take are slots the fill cannot use and coverage is incomplete. Every
    // dial fails, so nothing is corroborated.
    await expect(fullRun(runtime, [...otherPeers, ...deadPeers]))
      .resolves.toMatchObject({ requested: 0 });
    expect(runtime.status(CG, POLICY)?.unverified).toBe(true);
  });

  it('never reports a witnessed Context Graph clean while a reconnect fence is held', async () => {
    const { runtime } = createRuntime({
      requestPeer: async () => completed([{ id: 'promised-head' }]),
      parityFailed: async () => true,
    });

    await expect(fullRun(runtime, [HEALTHY_PEER])).resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status(CG, POLICY)?.failed).toBe(true);

    // A fence activates the Context Graph without running anything, so it may
    // not clear the witness: `failed` is derived, never mirrored.
    const lease = runtime.markPeerPending(CG, POLICY, HEALTHY_PEER);
    expect(lease).not.toBeNull();
    expect(runtime.status(CG, POLICY)).toEqual({
      active: true,
      failed: true,
      unresolvedPeerCount: 0,
      unverified: false,
    });

    // A reservation that is rejected releases the lease without a run.
    lease!.release();
    expect(runtime.status(CG, POLICY)).toEqual({
      active: false,
      failed: true,
      unresolvedPeerCount: 0,
      unverified: false,
    });
  });
});

const { startAgent, cleanup } = createRfc64RolloutAgentHarness();

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const GENESIS_ISSUED_AT = '1773900000000' as TimestampMsV1;
const DELEGATION_EFFECTIVE_AT = '1773899999000' as TimestampMsV1;
const DELEGATION_EXPIRES_AT = '1893456000000' as TimestampMsV1;
const SUCCESSOR_ISSUED_AT = '1773900001000' as TimestampMsV1;
const ASSERTION_ROOT = (
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f'
) as Digest32V1;
const PROJECTION = new TextEncoder().encode(
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n',
);

async function authorSeal(): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaNumber = 2647n;
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot: ASSERTION_ROOT,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: DEPLOYMENT.assertedAtKav10Address,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: '2',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

/** Give the edge one durable, self-consistent applied head for the rollout CG. */
async function applyConsistentGenesisHead(edge: Awaited<ReturnType<typeof startAgent>>) {
  const publication = await edge.publishOpenAuthorCatalogGenesisV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    author: Object.freeze({
      address: AUTHOR,
      signMessage: (digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest),
    }),
    peers: [],
    issuedAt: GENESIS_ISSUED_AT,
    catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
    catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
  });
  const scope = Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount: '1',
  }) as AuthorCatalogScopeV1;
  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const persistence = (edge as any).rfc64PersistenceV1;
  if (persistence === undefined) throw new Error('test edge has no RFC-64 persistence');
  persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
    catalogScopeDigest,
    authorAddress: AUTHOR,
    expectedCurrentCatalogHeadDigest: null,
    currentCatalogHeadDigest: publication.headObjectDigest,
    appliedInventoryDigest: computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest,
      rows: [],
    }),
    catalogVersion: publication.announcement.catalogVersion,
    inventoryRowCount: '0',
  });
  return publication;
}

/** Narrow view of the production catalog service used to stub provider replay. */
interface ReplayServiceV1 {
  requestCatalogHeadReplay(input: { remotePeerId: string }): Promise<unknown>;
}

function replayService(edge: Awaited<ReturnType<typeof startAgent>>): ReplayServiceV1 {
  return (edge as any).rfc64PublicCatalogServiceV1 as ReplayServiceV1;
}

async function readStatus(edge: Awaited<ReturnType<typeof startAgent>>) {
  const statuses = await edge.readRfc64CatalogOperationalStatusV1();
  const status = statuses.find((entry) => entry.contextGraphId === CONTEXT_GRAPH_ID);
  if (status === undefined) throw new Error('rollout CG missing from operational status');
  return status;
}

describe('RFC-64 operational status: provider failure reporting', () => {
  it('reports a converged Context Graph complete while one provider keeps failing replay', async () => {
    const edge = await startAgent({
      name: 'replay-peer-failure-parity-complete',
      activation: activation('catalog'),
    });
    await applyConsistentGenesisHead(edge);
    const failingPeer = '12D3KooWReplayPersistentlyUnreachable';
    const healthyPeer = '12D3KooWReplayHealthyProvider';
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([
      { toString: () => failingPeer },
      { toString: () => healthyPeer },
    ] as never);
    const requestReplay = vi.spyOn(replayService(edge), 'requestCatalogHeadReplay')
      .mockImplementation(async ({ remotePeerId }) => {
        if (remotePeerId === failingPeer) {
          throw new Rfc64PublicCatalogTransportErrorV1(
            'catalog-transport-wire',
            'provider persistently unreachable',
          );
        }
        return Object.freeze({
          kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
          heads: Object.freeze([]),
        });
      });

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 1, failed: 1 });

    const status = await readStatus(edge);
    expect(status).toMatchObject({
      phase: 'complete',
      stableReason: null,
      appliedRowCount: '0',
      expectedRowCount: '0',
      missingRowCount: '0',
      providerHealth: expect.objectContaining({
        candidateCount: 0,
        unresolvedReplayPeers: 1,
      }),
    });
    expect(status.expectedRowCount).toBe(status.appliedRowCount);
    expect(status.expectedCatalogHeadDigest).not.toBeNull();
    expect(status.expectedCatalogHeadDigest).toBe(status.appliedCatalogHeadDigest);
    expect(status.expectedInventoryDigest).not.toBeNull();
    expect(status.expectedInventoryDigest).toBe(status.appliedInventoryDigest);

    // The failing provider stays connected, so the next run retries it (two attempts).
    requestReplay.mockClear();
    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 1, failed: 1 });
    expect(requestReplay.mock.calls.filter(
      ([{ remotePeerId }]) => remotePeerId === failingPeer,
    )).toHaveLength(2);
    expect((await readStatus(edge)).providerHealth.unresolvedReplayPeers).toBe(1);
  });

  it('reports unknown provider health as null, never as zero failures', async () => {
    const edge = await startAgent({
      name: 'replay-provider-health-unknown',
      activation: activation('catalog'),
    });
    await applyConsistentGenesisHead(edge);
    expect((await readStatus(edge)).providerHealth.unresolvedReplayPeers).toBe(0);

    // Receiver ownership ended, so the runtime holds no replay progress for
    // this graph: "not known" must not read as "no provider failures", the way
    // every sibling field in this block already reports the unknown case.
    edge.clearRfc64CatalogOperationalTargetsV1(CONTEXT_GRAPH_ID);
    expect((await readStatus(edge)).providerHealth.unresolvedReplayPeers).toBeNull();
  });

  it('does not report a converged Context Graph complete when no provider answered', async () => {
    const edge = await startAgent({
      name: 'replay-peer-failure-uncorroborated',
      activation: activation('catalog'),
    });
    await applyConsistentGenesisHead(edge);
    const failingPeer = '12D3KooWReplayOnlyProviderUnreachable';
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([
      { toString: () => failingPeer },
    ] as never);
    vi.spyOn(replayService(edge), 'requestCatalogHeadReplay').mockRejectedValue(
      new Rfc64PublicCatalogTransportErrorV1(
        'catalog-transport-wire',
        'provider persistently unreachable',
      ),
    );

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 0, failed: 1 });

    // No manifest means the parity predicate was vacuously satisfied. That may
    // not be reported as "every provider agrees" -- and it is not evidence of
    // missing rows either, so it must not read as the blocked lane.
    const status = await readStatus(edge);
    expect(status).toMatchObject({
      phase: 'unknown-freshness',
      stableReason: 'catalog-replay-unverified',
      appliedRowCount: '0',
      expectedRowCount: null,
      missingRowCount: null,
      expectedInventoryDigest: null,
      providerHealth: expect.objectContaining({ unresolvedReplayPeers: 1 }),
    });
    expect(status.stableReason).not.toBe('catalog-replay-incomplete');
  });

  it('reports a verified promised row missing after its head announcement was lost', async () => {
    const edge = await startAgent({
      name: 'replay-promised-row-missing',
      activation: activation('catalog'),
    });
    const genesis = await applyConsistentGenesisHead(edge);
    // The successor is durable but deliberately has no announcement recipient,
    // reproducing the post-denial state: the replica still has only genesis.
    const successor = await edge.publishOpenAuthorCatalogSuccessorV1({
      previousHead: {
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assertionCoordinate: 'replay-promised-missing-row' as never,
      projectionBytes: PROJECTION,
      seal: await authorSeal(),
      deployment: DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [],
    });
    expect(successor.inventoryRowCount).toBe('1');

    const providerPeer = '12D3KooWReplayPromisedMissingRow';
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([
      { toString: () => providerPeer },
    ] as never);
    vi.spyOn(replayService(edge), 'requestCatalogHeadReplay').mockResolvedValue(
      Object.freeze({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
        heads: Object.freeze([successor.announcement]),
      }),
    );

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 1, failed: 1 });
    expect(await readStatus(edge)).toMatchObject({
      phase: 'blocked',
      stableReason: 'catalog-replay-incomplete',
      expectedRowCount: '1',
      appliedRowCount: '0',
      missingRowCount: '1',
    });
  });

  it('still blocks a Context Graph whose provider promises a head this node never applied', async () => {
    const edge = await startAgent({
      name: 'replay-peer-failure-parity-blocked',
      activation: activation('catalog'),
    });
    const publication = await applyConsistentGenesisHead(edge);
    const providerPeer = '12D3KooWReplayAheadProvider';
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([
      { toString: () => providerPeer },
    ] as never);
    vi.spyOn(replayService(edge), 'requestCatalogHeadReplay').mockImplementation(async () => {
      const promisedSuccessor = Object.freeze({
        ...publication.announcement,
        kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
        catalogVersion: '1',
        catalogHeadObjectDigest: `0x${'a1'.repeat(32)}`,
        signatureVariantDigest: `0x${'a2'.repeat(32)}`,
      }) as Rfc64PublicCatalogHeadAnnouncementV1;
      return Object.freeze({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
        heads: Object.freeze([promisedSuccessor]),
      });
    });

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 1, failed: 1 });
    expect(await readStatus(edge)).toMatchObject({
      phase: 'blocked',
      stableReason: 'catalog-replay-incomplete',
      expectedRowCount: null,
      missingRowCount: null,
      providerHealth: expect.objectContaining({
        candidateCount: null,
        unresolvedReplayPeers: 0,
      }),
    });
  });

  it('reads one accepted-policy snapshot per Context Graph for one status read', async () => {
    const edge = await startAgent({
      name: 'replay-accepted-policy-single-read',
      activation: activation('catalog'),
    });
    await applyConsistentGenesisHead(edge);
    const acceptedPolicySnapshot = vi.spyOn(
      (edge as any).rfc64PublicCatalogServiceV1,
      'acceptedPolicySnapshot',
    );

    await readStatus(edge);

    // The promised-target fence and the replay status must share one snapshot.
    // Reading it a second time spans the durable promised-row load, so an
    // accepted policy that rotates in that window pairs an old-digest promise
    // set with a null replay status, and the projection then publishes numbers
    // built from promises the runtime dropped at the rotation.
    expect(acceptedPolicySnapshot.mock.calls.filter(
      ([, contextGraphId]) => contextGraphId === CONTEXT_GRAPH_ID,
    )).toHaveLength(1);
  });
});
