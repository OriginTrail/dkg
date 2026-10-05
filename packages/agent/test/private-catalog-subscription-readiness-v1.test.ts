// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CG, MEMBER, POLICY, privateCatalogReadinessFixture as fixture, readinessApplied, readinessHead, readinessTarget } from './_helpers/private-catalog-readiness-fixture.js';
import { evaluateRfc64CatalogCompletionV1 } from '../src/rfc64/catalog-completion-evidence-v1.js';
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

  it.each([
    ['not subscribed', (f: Fixture) => { f.subscription.subscribed = false; }],
    ['service stopped', (f: Fixture) => { f.service.started = false; }],
    ['not join-derived', (f: Fixture) => { f.agent.isRfc64JoinDerivedAcceptedAuthorityV1.mockReturnValue(false); }],
    ['no approved identity', (f: Fixture) => { f.state.approvedAgent = undefined as never; }],
    ['authority unavailable', (f: Fixture) => { f.agent.resolveContextGraphSubscriptionBootstrapAuthority.mockResolvedValue({ outcome: 'unavailable' }); }],
    ['now registered', (f: Fixture) => { f.agent.resolveContextGraphSubscriptionBootstrapAuthority.mockResolvedValue({ outcome: 'allowed', registration: 'registered' }); }],
    ['no accepted policy', (f: Fixture) => { vi.spyOn(f.service, 'acceptedPolicySnapshot').mockReturnValue(null as never); }],
    ['public policy', (f: Fixture) => { f.service.acceptedPolicySnapshot().policy.accessPolicy = 0; }],
    ['another policy source', (f: Fixture) => { f.service.acceptedPolicySnapshot().policy.source.kind = 'finalized-registry'; }],
    ['no roster', (f: Fixture) => { f.service.acceptedPolicySnapshot().roster = null as never; }],
    ['no membership proof', (f: Fixture) => { f.agent.store.query.mockResolvedValue({ type: 'bindings', bindings: [] }); }],
    ['named legacy scope', (f: Fixture) => { f.agent.listSubGraphs.mockResolvedValue([{}]); }],
    ['unreadable promised head', (f: Fixture) => { f.faults.add(f.head.objectDigest); }],
    ['another network', (f: Fixture) => { f.state.networkId = 'other-network'; }],
    ['old authority era', (f: Fixture) => { f.service.acceptedPolicySnapshot().policy.era = '1'; }],
    ['author outside roster', (f: Fixture) => { f.service.acceptedPolicySnapshot().roster.members = [{ agentAddress: MEMBER }]; }],
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
