// SPDX-License-Identifier: Apache-2.0

/**
 * A share into a public graph that none of its recipients holds for the
 * others goes to the Cores its author is connected to as well
 * (`swm/relay-only-share-routes.ts`, route 3): which Cores, how they are
 * tracked, and which of them a refusal leaves out of the graph's next shares.
 * The other routes are in `swm-shares-through-relay.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { SHARE_HOLDER_REFUSAL_TTL_MS, chooseHoldingCores, shareHolderRefusalsOf } from '../src/swm/relay-only-share-routes.js';
import { peekOwedPublicShares } from '../src/swm/owed-public-shares.js';
import { DELIVERED, GRAPH, PEER_A, PEER_B, REFUSED, RETRY_LATER, agentWith, type ShareAnswer } from './_helpers/swm-share-fanout-agent.js';

// A relay-only member right after a graph is created: no Core subscribes to
// the graph yet, the owner is not found, and no other Edge has asked this
// one for the graph. The share went to nobody, silently. A Core that hosts
// the graph applies a member's sub-graph share without subscribing, and the
// other members pull it from there, so the share goes to the connected Cores.
describe('a share into a public graph that no recipient holds for others', () => {
  const CORES = ['core-1', 'core-2', 'core-3', 'core-4', 'core-5', 'core-6'];

  interface CoreHost {
    config: { nodeRole?: 'core' | 'edge' };
    peerCapabilityRegistry: { supportsCore(peerId: string): boolean };
    connectedSharedMemoryCoresV1(): Promise<string[]>;
    isPrivateContextGraph(contextGraphId: string): Promise<boolean>;
    resolveSwmAllowedPeersForCurrentAuthority(contextGraphId: string): Promise<string[] | null>;
    log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
    started: boolean;
  }

  async function withCores(options: {
    cores: string[];
    subscribers?: string[];
    followers?: string[];
    answer?: (peerId: string) => ShareAnswer;
    graph?: string;
  }) {
    const target = await agentWith({
      subscribers: options.subscribers ?? [],
      followers: options.followers ?? [],
      answer: options.answer,
      graph: options.graph,
    });
    const host = target.host as unknown as CoreHost;
    const cores = new Set(options.cores.concat((options.subscribers ?? []).filter((peerId) => peerId.startsWith('core-'))));
    host.peerCapabilityRegistry.supportsCore = (peerId) => cores.has(peerId);
    host.connectedSharedMemoryCoresV1 = async () => [...options.cores];
    return { ...target, coreHost: host };
  }

  it('goes to the connected Cores, which are tracked and retried like followers', async () => {
    const { agent, share } = await withCores({ cores: ['core-2', 'core-1'], answer: () => RETRY_LATER });
    expect(await share('reports')).toEqual(['core-1', 'core-2']);
    const tracked = agent.getSwmAckQuorumRecordSnapshotForTests('share-1');
    expect([...(tracked?.expectedMembers ?? [])].sort()).toEqual(['core-1', 'core-2']);
    expect([...(tracked?.directMembers ?? [])].sort()).toEqual(['core-1', 'core-2']);
  });

  it('goes to at most four Cores, the same ones for each share of a graph', async () => {
    const { share } = await withCores({ cores: CORES });
    const chosen = chooseHoldingCores({ contextGraphId: GRAPH, candidates: CORES, exclude: new Set(), refused: () => false });
    expect(chosen).toHaveLength(4);
    expect(await share('reports')).toEqual([...chosen].sort());
    expect(await share('reports')).toEqual([...chosen].sort());
  });

  it('goes to the Cores beside a follower, and to no extra Core when a Core subscribes', async () => {
    const withFollower = await withCores({ cores: ['core-1'], followers: [PEER_B] });
    expect(await withFollower.share('reports')).toEqual([PEER_B, 'core-1'].sort());
    const subscribedCore = await withCores({ cores: ['core-1', 'core-2'], subscribers: ['core-9'] });
    expect(await subscribedCore.share('reports')).toEqual(['core-9']);
  });

  it('goes to the Cores beside Edge subscribers, without remembering their answers as a subscriber\'s', async () => {
    const { agent, share } = await withCores({
      cores: ['core-1'],
      subscribers: [PEER_A],
      answer: (peerId) => (peerId === 'core-1' ? REFUSED : DELIVERED),
    });
    expect(await share('reports')).toEqual([PEER_A, 'core-1'].sort());
    expect(agent.getSwmFanoutPeerOutcomeForTests(GRAPH, PEER_A)).toBe('good');
    expect(agent.getSwmFanoutPeerOutcomeForTests(GRAPH, 'core-1')).toBeUndefined();
  });

  it('does not go to a Core for a private graph, an unreadable one, a captured roster, an allowlist, or from a Core', async () => {
    const privateGraph = await withCores({ cores: ['core-1'] });
    privateGraph.coreHost.isPrivateContextGraph = async () => true;
    expect(await privateGraph.share('reports')).toEqual([]);

    const unreadable = await withCores({ cores: ['core-1'] });
    unreadable.coreHost.isPrivateContextGraph = async () => { throw new Error('store unavailable'); };
    expect(await unreadable.share('reports')).toEqual([]);

    const allowlisted = await withCores({ cores: ['core-1'] });
    allowlisted.coreHost.resolveSwmAllowedPeersForCurrentAuthority = async () => [PEER_A];
    expect(await allowlisted.share('reports')).toEqual([PEER_A]);

    const fromCore = await withCores({ cores: ['core-1'] });
    fromCore.coreHost.config.nodeRole = 'core';
    expect(await fromCore.share('reports')).toEqual([]);

    const captured = await withCores({ cores: ['core-1'] });
    const sent: string[] = [];
    (captured.host.messenger as { sendReliable: (peerId: string) => Promise<unknown> }).sendReliable = async (peerId) => {
      sent.push(peerId);
      return DELIVERED;
    };
    await captured.agent.publishWorkspaceGossip(
      GRAPH,
      { message: new Uint8Array([7]), fanout: { kind: 'captured', snapshot: { source: 'agent-roster', members: [PEER_A], complete: true } } },
      createOperationContext('share'),
      null,
      'captured-share',
      { subGraphName: 'reports' },
    );
    await captured.agent.awaitInFlightSubstrateFanOuts();
    expect(sent).toEqual([PEER_A]);
  });

  it('does not go to a Core with a share into a root the catalog owns, and does with one on the direct lane', async () => {
    const catalogRoot = await withCores({ cores: ['core-1'] });
    catalogRoot.host.rfc64LegacySwmApplyAllowedForScope = (_contextGraphId, subGraphName) => subGraphName !== null;
    expect(await catalogRoot.share(null)).toEqual([]);
    const directRoot = await withCores({ cores: ['core-1'] });
    directRoot.host.rfc64LegacySwmApplyAllowedForScope = () => true;
    expect(await directRoot.share(null)).toEqual(['core-1']);
  });

  it('is sent again to a Core that asked for a retry, though the quorum is met, until it applies the share', async () => {
    let retryLater = true;
    const { agent, host, share } = await withCores({
      cores: ['core-1'],
      subscribers: Array.from({ length: 9 }, (_unused, index) => `edge-${index + 1}`),
      answer: (peerId) => (retryLater && peerId === 'core-1' ? RETRY_LATER : DELIVERED),
    });
    // Every subscriber is sent to: none of them is narrowed away in this case.
    (host as unknown as { selectSwmFanoutPeersForActiveShare: (input: { candidatePeers: readonly string[] }) => unknown })
      .selectSwmFanoutPeersForActiveShare = (input) => ({
        selectedPeers: [...input.candidatePeers],
        knownGoodPeers: [],
        unknownProbedPeers: [],
        skippedRecentPeers: [],
        candidatePeers: [...input.candidatePeers],
      });
    await share('reports');
    const pending = agent.getSwmAckQuorumRecordSnapshotForTests('share-1');
    expect(pending?.ackPct).toBeGreaterThanOrEqual(0.9);
    expect(pending?.directMembers).toEqual(['core-1']);
    retryLater = false;
    await agent.invokeSwmSubstrateTopUpForTests({
      shareOperationId: 'share-1',
      cgId: GRAPH,
      payload: new Uint8Array([1, 2, 3, 1]),
      missingPeers: ['core-1'],
    });
    expect(agent.getSwmAckQuorumRecordSnapshotForTests('share-1')).toBeUndefined();
  });

  it('leaves out a Core that refused the graph\'s share for ten minutes, and takes another', async () => {
    let now = 5_000_000;
    const target = await withCores({
      cores: ['core-1', 'core-2', 'core-3'],
      answer: (peerId) => (peerId === 'core-1' ? REFUSED : RETRY_LATER),
    });
    shareHolderRefusalsOf(target.agent, () => now);
    target.coreHost.connectedSharedMemoryCoresV1 = async () => ['core-1', 'core-2'];
    expect(await target.share('reports')).toEqual(['core-1', 'core-2']);
    expect(target.agent.getSwmAckQuorumRecordSnapshotForTests('share-1')?.expectedMembers).toEqual(['core-2']);

    target.coreHost.connectedSharedMemoryCoresV1 = async () => ['core-1', 'core-2', 'core-3'];
    expect(await target.share('reports')).toEqual(['core-2', 'core-3']);
    now += SHARE_HOLDER_REFUSAL_TTL_MS;
    expect(await target.share('reports')).toEqual(['core-1', 'core-2', 'core-3']);
  });

  // A Core refuses an outdated version of an asset as it refuses a graph it
  // does not host. One that applied a share of the graph lately hosts it: its
  // refusal of one share must not keep it from the next share, of another asset.
  it('keeps a Core that applied a share of the graph lately after it refuses one, and leaves out a Core that applied none', async () => {
    let answers: Record<string, ShareAnswer> = { 'core-1': DELIVERED, 'core-2': REFUSED };
    const target = await withCores({ cores: ['core-1', 'core-2'], answer: (peerId) => answers[peerId] ?? DELIVERED });
    const refusals = shareHolderRefusalsOf(target.agent);
    expect(await target.share('reports')).toEqual(['core-1', 'core-2']);
    expect(refusals.refused(GRAPH, 'reports', 'core-2'), 'a Core that applied none of the graph\'s shares does not host it').toBe(true);

    // An outdated version of the asset: the Core that applied the last share refuses it.
    answers = { 'core-1': REFUSED, 'core-2': REFUSED };
    expect(await target.share('reports')).toEqual(['core-1']);
    expect(refusals.refused(GRAPH, 'reports', 'core-1')).toBe(false);

    answers = { 'core-1': DELIVERED, 'core-2': DELIVERED };
    expect(await target.share('drafts'), 'a fresh share of another asset still goes to the Core that hosts the graph').toEqual(['core-1']);
  });

  it('says in its fan-out line how many Cores it went to', async () => {
    const { coreHost, share } = await withCores({ cores: ['core-1', 'core-2'] });
    const info = vi.spyOn(coreHost.log, 'info');
    await share('reports');
    expect(info.mock.calls.map(([, message]) => String(message)).find((line) => line.startsWith('SWM substrate fan-out')))
      .toMatch(/ cores=2$/);
  });

  it('is not silent when it reaches nobody: a started node warns and keeps it, a node not started keeps nothing', async () => {
    const notStarted = await withCores({ cores: [] });
    const quiet = vi.spyOn(notStarted.coreHost.log, 'warn');
    expect(await notStarted.share('reports')).toEqual([]);
    expect(quiet.mock.calls.map(([, message]) => String(message)).filter((line) => line.includes('reached no peer'))).toHaveLength(1);
    expect(peekOwedPublicShares(notStarted.agent)).toBeUndefined();

    const running = await withCores({ cores: [] });
    const warn = vi.spyOn(running.coreHost.log, 'warn');
    running.coreHost.started = true;
    try {
      expect(await running.share('reports')).toEqual([]);
      const lines = warn.mock.calls.map(([, message]) => String(message)).filter((line) => line.includes('reached no peer'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('sub-graph "reports"');
      expect(lines[0]).toContain('op=share-1');
      expect(lines[0]).toContain('kept for 30 min');
      expect(peekOwedPublicShares(running.agent)?.snapshot()).toMatchObject([{ shareOperationId: 'share-1', holder: true, owner: false }]);
      // While the node stops, a share is no longer kept; once it starts again it is.
      running.agent.stopOwedPublicSharesV1();
      expect(await running.share('reports')).toEqual([]);
      expect(peekOwedPublicShares(running.agent)?.size).toBe(0);
      running.agent.reopenOwedPublicSharesV1();
      expect(await running.share('reports')).toEqual([]);
      expect(peekOwedPublicShares(running.agent)?.snapshot()).toMatchObject([{ shareOperationId: 'share-3' }]);
    } finally {
      running.agent.stopOwedPublicSharesV1();
      running.coreHost.started = false;
    }
    expect(peekOwedPublicShares(running.agent)?.closed).toBe(true);
  });
});
