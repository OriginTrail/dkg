// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CG, MEMBER, POLICY, privateCatalogReadinessFixture as fixture, readinessApplied, readinessHead, readinessTarget } from './_helpers/private-catalog-readiness-fixture.js';
import { Rfc64CatalogReplayConnectionRuntimeV1 } from '../src/rfc64/catalog-replay-connection-runtime-v1.js';
import { evaluateRfc64CatalogCompletionV1 } from '../src/rfc64/catalog-completion-evidence-v1.js';
import { rfc64CatalogTargetExactIdentityKeyV1 } from '../src/rfc64/catalog-operational-targets-v1.js';
import { loadRfc64OperationalAppliedHeadsV1 } from '../src/rfc64/catalog-operational-applied-heads-v1.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Move facts on the final requester read, after the two membership-proof reads. */
function onFinalRead(f: Fixture, change: () => void | Promise<void>) {
  f.agent.readRequesterJoinRequestState.mockResolvedValueOnce(f.requester).mockResolvedValueOnce(f.requester)
    .mockImplementationOnce(async () => { await change(); return f.requester; });
}

describe('approved private catalog readiness handoff', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('commits corroborated durable parity without interpreting operator status', async () => {
    const f = await fixture();
    await expect(f.run()).resolves.toBe(true);
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.agent.readRfc64CatalogOperationalStatusV1).not.toHaveBeenCalled();
    expect(f.agent.resolveContextGraphSubscriptionBootstrapAuthority).toHaveBeenCalledWith(CG, {
      callerAgentAddress: MEMBER, allowSubscriptionFallback: false,
    });
  });

  it('withholds old corroborated readiness while the 257th scope is deferred before admission', async () => {
    const f = await fixture();
    await expect(f.run()).resolves.toBe(true);
    f.commit.mockClear();
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => [...Array.from({ length: 256 }, (_, i) => `a-${String(i).padStart(3, '0')}`), CG],
      reserveFence: (cg, peer) => f.state.replay.reservePeer(cg, POLICY, peer),
      schedule: () => false, wait: async () => undefined, warn: vi.fn(),
      reannounce: async () => ({ failed: 0 }), replay: async () => ({ failed: 0 }),
    });
    const reservation = runtime.prepareConnectionOpen('curator-peer')!;
    expect(f.state.replay.status(CG, POLICY)?.active).toBe(true);
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
    reservation.reject();
    expect(f.state.replay.status(CG, POLICY)?.active).toBe(false);
    await expect(f.run()).resolves.toBe(true);
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it('cannot certify a partial restored catalog after losing a second advertised head', async () => {
    const f = await fixture({ restored: true });
    const missing = readinessHead({ authorAddress: MEMBER });
    f.objects.set(missing.objectDigest, missing);
    f.setProviderTargets([readinessTarget(f.head), readinessTarget(missing)]);
    await f.replay();
    expect(f.state.replay.status(CG, POLICY)?.failed).toBe(true);
    await expect(f.run()).resolves.toBe(false);
    f.restartReplay();
    expect(f.state.replay.status(CG, POLICY)).toBeNull();
    await expect(f.run()).resolves.toBe(false);
    // A peer walk with nobody connected cannot restore forgotten evidence.
    f.agent.node.libp2p.getPeers = () => [];
    await f.replay();
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
    // The same restored inventory becomes eligible only after the missing
    // head is durably applied and a provider corroborates both heads.
    f.setInventory([readinessApplied(f.head), readinessApplied(missing)]);
    f.agent.node.libp2p.getPeers = () => ['curator-peer'];
    await f.replay();
    await expect(f.run()).resolves.toBe(true);
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it('requires fresh corroboration even for a fully restored inventory', async () => {
    const f = await fixture({ restored: true });
    await expect(f.run()).resolves.toBe(false);
    await f.replay();
    await expect(f.run()).resolves.toBe(true);
  });

  it.each([
    ['another network', { networkId: 'another-network' }],
    ['named scope', { subGraphName: 'named' }],
    ['old era', { era: '1' }],
    ['unlisted author', { authorAddress: '0x3333333333333333333333333333333333333333' }],
  ])('rejects a corroborated head from %s using typed scope facts', async (_label, scope) => {
    const f = await fixture({ restored: true });
    const head = readinessHead(scope as never);
    f.objects.set(head.objectDigest, head);
    f.setInventory([readinessApplied(head)]);
    f.setProviderTargets([readinessTarget(head)]);
    await f.replay();
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('rejects a replay that was reset and re-completed during the reads', async () => {
    const f = await fixture();
    onFinalRead(f, async () => { f.state.replay.reset(); await f.replay(); });
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('keeps diagnostic parity distinct from provider corroboration', async () => {
    const f = await fixture({ restored: true });
    const heads = await loadRfc64OperationalAppliedHeadsV1(f.state.persistence as never);
    const evidence = evaluateRfc64CatalogCompletionV1({
      heads, targets: [], promisedTargets: null, promisedRowCounts: new Map(), replay: null, targetCapacityExceeded: false,
    });
    expect(evidence.rowProjection).toEqual({ expectedRowCount: '1', missingRowCount: '0' });
    expect(evidence.expectedCatalogHeadDigest).toBe(evidence.catalogHeadDigest);
    expect(evidence.corroborated).toBe(false);
  });

  it.each([false, true])('projects the newest retained head regardless of promise order (reverse=%s)', async (reverse) => {
    const f = await fixture({ restored: true });
    const heads = await loadRfc64OperationalAppliedHeadsV1(f.state.persistence as never);
    const two = readinessTarget(readinessHead({ version: '2' }));
    const three = readinessTarget(readinessHead({ version: '3' }));
    const promises = reverse ? [three, two] : [two, three];
    const evidence = evaluateRfc64CatalogCompletionV1({ heads, targets: [], promisedTargets: promises,
      promisedRowCounts: new Map(), replay: null, targetCapacityExceeded: false });
    expect(evidence.pendingTargets).toHaveLength(2);
    expect(evidence.liveTargetsPending).toBe(false);
    expect(evidence.expectedCatalogHeadDigest).toBe(three.catalogHeadObjectDigest);
    expect(evidence.corroborated).toBe(false);
    const live = evaluateRfc64CatalogCompletionV1({ heads, targets: [three], promisedTargets: promises,
      promisedRowCounts: new Map(), replay: null, targetCapacityExceeded: false });
    expect(live.pendingTargets).toHaveLength(2);
    expect(live.liveTargetsPending).toBe(true);
    expect(live.expectedCatalogHeadDigest).toBe(three.catalogHeadObjectDigest);
  });

  it.each([false, true])('shares newest-head resolution for digest and counts after an older fork (reverse=%s)', async (reverse) => {
    const f = await fixture({ restored: true });
    const heads = await loadRfc64OperationalAppliedHeadsV1(f.state.persistence as never);
    const older = readinessTarget(readinessHead({ version: '2' }));
    const fork = readinessTarget(readinessHead({ version: '2', totalRows: '0' }));
    const newest = readinessTarget(readinessHead({ version: '3', totalRows: '4' }));
    const promisedTargets = reverse ? [newest, fork, older] : [older, fork, newest];
    const evidence = evaluateRfc64CatalogCompletionV1({ heads, targets: [], promisedTargets,
      promisedRowCounts: new Map([[rfc64CatalogTargetExactIdentityKeyV1(newest), '4']]),
      replay: null, targetCapacityExceeded: false });
    expect(evidence.expectedCatalogHeadDigest).toBe(newest.catalogHeadObjectDigest);
    expect(evidence.rowProjection).toEqual({ expectedRowCount: '4', missingRowCount: '3' });
    expect(evidence.liveTargetsPending).toBe(false);
    const noCounts = evaluateRfc64CatalogCompletionV1({ heads, targets: [], promisedTargets,
      promisedRowCounts: new Map(), replay: null, targetCapacityExceeded: false });
    expect(noCounts.expectedCatalogHeadDigest).toBe(newest.catalogHeadObjectDigest);
    expect(noCounts.rowProjection).toEqual({ expectedRowCount: null, missingRowCount: null });
  });

  it.each([false, true])('keeps both projections ambiguous for a newest-version fork (reverse=%s)', async (reverse) => {
    const f = await fixture({ restored: true });
    const heads = await loadRfc64OperationalAppliedHeadsV1(f.state.persistence as never);
    const left = readinessTarget(readinessHead({ version: '2' }));
    const right = readinessTarget(readinessHead({ version: '2', totalRows: '0' }));
    const evidence = evaluateRfc64CatalogCompletionV1({ heads, targets: [],
      promisedTargets: reverse ? [right, left] : [left, right],
      promisedRowCounts: new Map([[rfc64CatalogTargetExactIdentityKeyV1(left), '1'], [rfc64CatalogTargetExactIdentityKeyV1(right), '0']]),
      replay: null, targetCapacityExceeded: false });
    expect(evidence.expectedCatalogHeadDigest).toBeNull();
    expect(evidence.rowProjection).toEqual({ expectedRowCount: null, missingRowCount: null });
  });

  it('reports an unknown expected digest for competing retained heads at the applied version', async () => {
    const f = await fixture({ restored: true });
    const heads = await loadRfc64OperationalAppliedHeadsV1(f.state.persistence as never);
    const conflict = readinessTarget(readinessHead({ totalRows: '0' }));
    const evidence = evaluateRfc64CatalogCompletionV1({ heads, targets: [], promisedTargets: [conflict],
      promisedRowCounts: new Map(), replay: null, targetCapacityExceeded: false });
    expect(evidence.pendingTargets).toEqual([conflict]);
    expect(evidence.expectedCatalogHeadDigest).toBeNull();
    expect(evidence.liveTargetsPending).toBe(false);
    expect(evidence.corroborated).toBe(false);
  });

  it.each([
    ['not subscribed', (f: Fixture) => { f.subscription.subscribed = false; }],
    ['service stopped', (f: Fixture) => { f.service.started = false; }],
    ['not join-derived', (f: Fixture) => { f.agent.isRfc64JoinDerivedAcceptedAuthorityV1.mockReturnValue(false); }],
    ['no approved identity', (f: Fixture) => { f.state.approvedAgent = undefined as never; }],
    ['authority unavailable', (f: Fixture) => { f.agent.resolveContextGraphSubscriptionBootstrapAuthority.mockResolvedValue({ outcome: 'unavailable' }); }],
    ['now registered', (f: Fixture) => { f.agent.resolveContextGraphSubscriptionBootstrapAuthority.mockResolvedValue({ outcome: 'allowed', registration: 'registered' }); }],
    ['no accepted policy', (f: Fixture) => { vi.spyOn(f.service, 'acceptedPolicySnapshot').mockReturnValue(null as never); }],
    ['public policy', (f: Fixture) => f.updateAccepted((a) => { a.policy.accessPolicy = 0; })],
    ['another policy source', (f: Fixture) => f.updateAccepted((a) => { a.policy.source.kind = 'finalized-registry'; })],
    ['no roster', (f: Fixture) => f.updateAccepted((a) => { a.roster = null as never; })],
    ['another owner', (f: Fixture) => f.updateAccepted((a) => { a.policy.source.ownerAddress = MEMBER; })],
    ['no membership proof', (f: Fixture) => { f.agent.store.query.mockResolvedValue({ type: 'bindings', bindings: [] }); }],
    ['named legacy scope', (f: Fixture) => { f.agent.listSubGraphs.mockResolvedValue([{}]); }],
    ['unreadable promised head', (f: Fixture) => { f.faults.add(f.head.objectDigest); }],
    ['another network', (f: Fixture) => { f.state.networkId = 'other-network'; }],
    ['old authority era', (f: Fixture) => f.updateAccepted((a) => { a.policy.era = '1'; })],
    ['author outside roster', (f: Fixture) => f.updateAccepted((a) => { a.roster.members = [{ agentAddress: MEMBER }]; })],
    ['stale authority', (f: Fixture) => { f.state.authorityCurrent = false; }],
    ['legacy rows', (f: Fixture) => { f.state.legacyReadOnlyCount = 1; }],
    ['target overflow', (f: Fixture) => { f.state.targetCapacityExceeded = true; }],
    ['failed target', (f: Fixture) => { f.state.targetFailed = true; }],
    ['missing applied head', (f: Fixture) => { f.setInventory([]); }],
    ['empty data', (f: Fixture) => { f.setInventory([{ ...readinessApplied(f.head), inventoryRowCount: '0' as never }]); }],
  ])('rejects %s', async (_label, change) => {
    const f = await fixture(); change(f);
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('rejects an unreadable newer applied head in a promised scope', async () => {
    const f = await fixture();
    const newer = readinessHead({ version: '2' });
    f.objects.set(newer.objectDigest, newer);
    f.setInventory([readinessApplied(newer)]);
    f.faults.add(newer.objectDigest);
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('ignores unrelated unreadable inventory and replay transitions during verification', async () => {
    const f = await fixture();
    const other = readinessHead({ contextGraphId: 'another-graph' as never });
    onFinalRead(f, async () => {
      f.setInventory([readinessApplied(f.head), readinessApplied(other)]);
      f.faults.add(other.objectDigest);
      await f.state.replay.request({ contextGraphId: 'another-graph', policyDigest: POLICY,
        kind: 'full-connected-peers', connectedPeerIds: ['curator-peer'] });
    });
    await expect(f.run()).resolves.toBe(true);
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it.each([
    ['metadata', (f: Fixture) => { f.state.metadataRevision += 1; }],
    ['service instance', (f: Fixture) => { f.state.service = { ...f.service }; }],
    ['persistence instance', (f: Fixture) => { f.state.persistence = { ...f.state.persistence }; }],
    ['network', (f: Fixture) => { f.state.networkId = 'another-network'; }],
    ['approved identity', (f: Fixture) => { f.state.approvedAgent = 'another-agent'; }],
    ['authority', (f: Fixture) => { f.state.authorityRevision += 1; }],
    ['policy', (f: Fixture) => f.rotatePolicy()],
    ['replay', (f: Fixture) => { f.state.replay.markPeerPending(CG, POLICY, 'another-peer'); }],
    ['inventory', (f: Fixture) => { f.setInventory([]); }],
    ['targets', (f: Fixture) => { f.state.targetFence = 'new-target'; }],
    ['unsubscribe', (f: Fixture) => { f.subscription.subscribed = false; }],
    ['registration', (f: Fixture) => { f.subscription.onChainId = '7'; }],
    ['request generation', (f: Fixture) => { f.requester.requestGeneration = 'request-2'; }],
    ['approval', (f: Fixture) => { f.requester.status = 'rejected'; }],
    ['curator peer', (f: Fixture) => { f.requester.curatorPeerId = 'another-curator'; }],
    ['curator owner', (f: Fixture) => { f.requester.curatorAgentAddress = MEMBER; }],
    ['curator era', (f: Fixture) => { f.requester.curatorAuthorityEra = '1'; }],
    ['local agent', (f: Fixture) => { f.agent.listLocalAgents.mockReturnValue([]); }],
    ['transport authority', (f: Fixture) => { f.agent.isRfc64CatalogTransportAuthorityActiveV1.mockReturnValue(false); }],
    ['shutdown', (f: Fixture) => { f.service.started = false; }],
    ['rollout', (f: Fixture) => { f.state.plan = {}; }],
  ])('fences %s moving during the reads', async (_label, move) => {
    const f = await fixture();
    onFinalRead(f, () => move(f));
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('rejects approval disappearing on the final read', async () => {
    const f = await fixture();
    f.agent.readRequesterJoinRequestState.mockResolvedValueOnce(f.requester).mockResolvedValueOnce(f.requester).mockResolvedValueOnce(null);
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('rechecks the delegation deadline at commit', async () => {
    const f = await fixture(); vi.useFakeTimers(); vi.setSystemTime(10_000);
    f.agent.store.query.mockResolvedValue({ type: 'bindings', bindings: [{ delegationExpiresAt: '11000' }] });
    onFinalRead(f, () => { vi.setSystemTime(11_000); });
    await expect(f.run()).resolves.toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });
});
