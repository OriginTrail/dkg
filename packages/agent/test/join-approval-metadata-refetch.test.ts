// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE,
  DKG_ONTOLOGY,
  PROTOCOL_JOIN_REQUEST,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { agentFromPrivateKey, DKGAgent } from '../src/index.js';
import { watchCuratorRegistrationRefusal } from '../src/curator-registration-refusal.js';
import {
  runJoinApprovalMetadataRecovery,
  runPostApprovalSyncWithMetadataRecovery,
} from '../src/join-approval-metadata-refetch.js';
import {
  resolveApprovedMemberAcceptanceDecision,
  unprovenApprovedMemberAcceptance,
} from '../src/internal/context-graph-authority/approved-member-acceptance.js';
import type { ContextGraphSub } from '../src/dkg-agent-types.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

const CURATOR_PEER = '12D3KooWJoinMetadataRefetchCurator';
const CURATOR_AGENT = '0x00000000000000000000000000000000000000c1';
const TRANSPORT_FAILURE = 'Remote closed connection during opening';

type JoinRequestHandler = (data: Uint8Array, peerId: string) => Promise<Uint8Array>;
type MetadataFetchOutcome = SyncPageResult['quads'] | Error;

/** The parts of the agent these tests reach past its public surface for. */
interface MemberInternals {
  localAgents: Map<string, unknown>;
  defaultAgentAddress: string;
  localApprovedAgentByCG: Map<string, string>;
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  messenger: { handlers: Map<string, JoinRequestHandler> };
  networkAdmissionCoordinator: { ensureAdmitted(peerId: string): Promise<boolean> };
  isTrustedJoinDecisionSender(): Promise<boolean>;
  resolveSwmTransportAuthority(): Promise<{ kind: 'private-roster'; participantAgents: string[] }>;
  fetchSyncPages(
    ctx: unknown,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: string,
  ): Promise<SyncPageResult>;
}

const internalsOf = (agent: DKGAgent) => agent as unknown as MemberInternals;

/** The curator's root metadata for a private graph that lists `member`. */
function curatorSnapshot(
  contextGraphId: string,
  member: string,
  memberPeerId: string,
  onChainId?: string,
) {
  const subject = contextGraphDataGraphUri(contextGraphId);
  const graph = contextGraphMetaGraphUri(contextGraphId);
  const delegation = `did:dkg:agent-delegation:${contextGraphId}:${member.toLowerCase()}`;
  const literal = (value: string) => JSON.stringify(value);
  return [
    { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph },
    { subject, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: literal('private'), graph },
    { subject, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${CURATOR_AGENT}`, graph },
    { subject, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${CURATOR_AGENT}`, graph },
    { subject, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: literal(member.toLowerCase()), graph },
    ...(onChainId === undefined ? [] : [
      { subject, predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, object: literal(onChainId), graph },
    ]),
    { subject: delegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: literal(member.toLowerCase()), graph },
    { subject: delegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT, object: literal(String(Date.now() - 60_000)), graph },
    { subject: delegation, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: literal(memberPeerId), graph },
  ];
}

describe('metadata of a join approved while the node runs (#3109)', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await agent?.stop().catch(() => {});
    agent = undefined;
    vi.restoreAllMocks();
  });

  /** A running member node with one local agent. */
  async function startMember(name: string): Promise<DKGAgent> {
    const member = await DKGAgent.create({
      name,
      listenHost: '127.0.0.1',
      listenPort: 0,
      skills: [],
      chainAdapter: new MockChainAdapter(),
    });
    await member.start();
    const local = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, `${name}-agent`);
    internalsOf(member).localAgents.set(local.agentAddress, local);
    internalsOf(member).defaultAgentAddress = local.agentAddress;
    return member;
  }

  /**
   * The curator is connected and answers a catch-up; what its metadata fetch
   * returns, and when, is decided per call by `metadataFetch`. Everything
   * between the approval and that fetch runs for real.
   */
  function reachCurator(
    member: DKGAgent,
    contextGraphId: string,
    metadataFetch: (attempt: number) => MetadataFetchOutcome | Promise<MetadataFetchOutcome>,
  ) {
    const calls = { metadataFetches: 0, catchUps: 0, broadcasts: 0 };
    vi.spyOn(member.node.libp2p, 'getConnections').mockReturnValue([
      { remotePeer: { toString: () => CURATOR_PEER } },
    ] as never);
    internalsOf(member).networkAdmissionCoordinator.ensureAdmitted = async () => true;
    vi.spyOn(member, 'ensurePeerConnected').mockResolvedValue(undefined);
    vi.spyOn(member, 'runCatchupOverPeers').mockImplementation(async () => {
      calls.catchUps += 1;
      // An empty graph: the curator answers cleanly and has nothing to send.
      return {
        peersSucceeded: 1,
        dataSynced: 0,
        sharedMemorySynced: 0,
        sharedMemoryCompletedCleanly: true,
        denied: false,
      } as never;
    });
    vi.spyOn(member, 'syncContextGraphFromConnectedPeers').mockImplementation(async () => {
      calls.broadcasts += 1;
      return undefined as never;
    });
    vi.spyOn(internalsOf(member), 'fetchSyncPages').mockImplementation(
      async (_ctx, remotePeerId, id, _includeSharedMemory, phase) => {
        if (remotePeerId !== CURATOR_PEER || id !== contextGraphId || phase !== 'meta') {
          throw new Error(`unexpected fetch of ${id}/${phase} from ${remotePeerId}`);
        }
        const attempt = calls.metadataFetches += 1;
        const outcome = await metadataFetch(attempt);
        if (outcome instanceof Error) throw outcome;
        return {
          quads: outcome,
          checkpointKey: `join-metadata-refetch-${attempt}`,
          resumedFromOffset: 0,
          completed: true,
        } as SyncPageResult;
      },
    );
    // A registered private graph with the member in its roster: the snapshot
    // is judged as private metadata and the member's reads are allowed.
    internalsOf(member).resolveSwmTransportAuthority = async () => ({
      kind: 'private-roster',
      participantAgents: [member.getDefaultAgentAddress()!],
    });
    vi.spyOn(member, 'resolveContextGraphReadAuthority').mockResolvedValue({
      outcome: 'allowed',
      source: 'registered-chain',
      reason: 'chain-participant',
      metadataBootstrap: 'eligible',
    });
    return calls;
  }

  /** The row and approval binding the join-approved handler leaves behind. */
  function approve(member: DKGAgent, contextGraphId: string, row: Partial<ContextGraphSub> = {}) {
    const address = member.getDefaultAgentAddress()!.toLowerCase();
    internalsOf(member).localApprovedAgentByCG.set(contextGraphId, address);
    internalsOf(member).subscribedContextGraphs.set(contextGraphId, {
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
      syncMode: 'always-on',
      ...row,
    });
    return address;
  }

  it('fetches the metadata again when both fetches after a live approval fail in transport', async () => {
    agent = await startMember('JoinMetadataRefetch');
    const contextGraphId = 'join-metadata-refetch';
    const member = agent.getDefaultAgentAddress()!;
    const requestGeneration = `0x${'7'.repeat(64)}`;
    const snapshot = curatorSnapshot(contextGraphId, member, agent.peerId);
    // Both fetches of the post-approval sync fail; the curator answers after.
    const calls = reachCurator(agent, contextGraphId, (attempt) => (
      attempt <= 2 ? new Error(TRANSPORT_FAILURE) : snapshot
    ));
    internalsOf(agent).isTrustedJoinDecisionSender = async () => true;
    await agent.setRequesterJoinRequestPending(contextGraphId, member, requestGeneration, CURATOR_PEER);

    const handler = internalsOf(agent).messenger.handlers.get(PROTOCOL_JOIN_REQUEST)!;
    const response = await handler(
      new TextEncoder().encode(JSON.stringify({
        type: 'join-approved',
        contextGraphId,
        agentAddress: member,
        requestGeneration,
      })),
      CURATOR_PEER,
    );
    expect(JSON.parse(new TextDecoder().decode(response))).toEqual({ ok: true });

    // Without a restart the member holds confirmed metadata, and with it the
    // declaration a write is checked against.
    const running = agent;
    await vi.waitFor(() => {
      expect(running.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
        subscribed: true,
        metaSynced: true,
        pendingMeta: false,
      });
    }, { timeout: 20_000, interval: 25 });
    await expect(agent.contextGraphExists(contextGraphId)).resolves.toBe(true);
    await expect(agent.hasConfirmedMetaState(contextGraphId)).resolves.toBe(true);
    // The recovery then completes the join with the sync a first fetch would
    // have led to: one more fetch and catch-up, and no second broadcast.
    await vi.waitFor(() => expect(calls.catchUps).toBe(2), { timeout: 20_000, interval: 25 });
    expect(calls).toEqual({ metadataFetches: 4, catchUps: 2, broadcasts: 1 });
  }, 60_000);

  it('starts no recovery after a sync whose first fetch succeeded', async () => {
    agent = await startMember('JoinMetadataFirstFetch');
    const contextGraphId = 'join-metadata-first-fetch';
    const member = approve(agent, contextGraphId);
    const snapshot = curatorSnapshot(contextGraphId, member, agent.peerId);
    const calls = reachCurator(agent, contextGraphId, () => snapshot);
    const recover = vi.spyOn(agent, 'recoverPendingJoinApprovalMetadata');

    await runPostApprovalSyncWithMetadataRecovery(agent, contextGraphId, CURATOR_PEER);

    expect(recover).not.toHaveBeenCalled();
    expect(calls).toEqual({ metadataFetches: 1, catchUps: 1, broadcasts: 0 });
    expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      metaSynced: true,
      pendingMeta: false,
    });
  }, 30_000);

  it('does not fetch again a snapshot that was refused for the registration it names', async () => {
    agent = await startMember('JoinMetadataRefusedSnapshot');
    const contextGraphId = 'join-metadata-refused-snapshot';
    // The row owns one registration, the curator's snapshot names another.
    const member = approve(agent, contextGraphId, { onChainId: '582' });
    const calls = reachCurator(agent, contextGraphId, () => (
      curatorSnapshot(contextGraphId, member, agent!.peerId, '323')
    ));
    const recover = vi.spyOn(agent, 'recoverPendingJoinApprovalMetadata');

    await runPostApprovalSyncWithMetadataRecovery(agent, contextGraphId, CURATOR_PEER);

    // The two fetches of the sync itself, and none after it.
    expect(calls.metadataFetches).toBe(2);
    expect(recover).not.toHaveBeenCalled();
    await expect(agent.contextGraphExists(contextGraphId)).resolves.toBe(false);
    expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      onChainId: '582',
      pendingMeta: true,
    });
  }, 30_000);

  it('recovers after failed fetches although an earlier snapshot of the same curator was refused', async () => {
    agent = await startMember('JoinMetadataRefusalThenFailure');
    const contextGraphId = 'join-metadata-refusal-then-failure';
    const member = approve(agent, contextGraphId, { onChainId: '582' });
    const foreign = curatorSnapshot(contextGraphId, member, agent.peerId, '323');
    const owned = curatorSnapshot(contextGraphId, member, agent.peerId, '582');
    // A first approval is refused. The curator then names the registration the
    // row owns, but both fetches after its next approval fail in transport.
    const calls = reachCurator(agent, contextGraphId, (attempt) => {
      if (attempt <= 2) return foreign;
      return attempt <= 4 ? new Error(TRANSPORT_FAILURE) : owned;
    });

    await runPostApprovalSyncWithMetadataRecovery(agent, contextGraphId, CURATOR_PEER);
    expect(calls).toEqual({ metadataFetches: 2, catchUps: 1, broadcasts: 1 });
    await expect(agent.contextGraphExists(contextGraphId)).resolves.toBe(false);

    await runPostApprovalSyncWithMetadataRecovery(agent, contextGraphId, CURATOR_PEER);

    // A failed fetch is not a refusal: the recovery ran and completed the join.
    expect(calls).toEqual({ metadataFetches: 6, catchUps: 3, broadcasts: 2 });
    await expect(agent.contextGraphExists(contextGraphId)).resolves.toBe(true);
    expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      onChainId: '582',
      metaSynced: true,
      pendingMeta: false,
    });
  }, 30_000);

  it('ends a recovery attempt on a refused snapshot and keeps it going on a failed fetch', async () => {
    agent = await startMember('JoinMetadataRecoveryOutcome');
    const contextGraphId = 'join-metadata-recovery-outcome';
    const member = approve(agent, contextGraphId, { onChainId: '582' });
    const foreign = curatorSnapshot(contextGraphId, member, agent.peerId, '323');
    const owned = curatorSnapshot(contextGraphId, member, agent.peerId, '582');
    const calls = reachCurator(agent, contextGraphId, (attempt) => (
      [new Error(TRANSPORT_FAILURE), foreign, new Error(TRANSPORT_FAILURE), owned][attempt - 1] ?? owned
    ));
    const sync = vi.spyOn(agent, 'runImmediatePostApprovalSync').mockResolvedValue(undefined);

    // A fetch that fails in transport says nothing about the snapshot.
    await expect(agent.resumePendingJoinApprovalMetadata(contextGraphId, CURATOR_PEER))
      .resolves.toBe('retry');
    // A snapshot the node refused for its registration is not worth another fetch.
    await expect(agent.resumePendingJoinApprovalMetadata(contextGraphId, CURATOR_PEER))
      .resolves.toBe('stop');
    // The refusal belongs to that attempt: a later failed fetch is a failed fetch.
    await expect(agent.resumePendingJoinApprovalMetadata(contextGraphId, CURATOR_PEER))
      .resolves.toBe('retry');
    expect(calls.metadataFetches).toBe(3);
    expect(sync).not.toHaveBeenCalled();

    await expect(agent.resumePendingJoinApprovalMetadata(contextGraphId, CURATOR_PEER))
      .resolves.toBe('completed');
    expect(sync).toHaveBeenCalledWith(contextGraphId, CURATOR_PEER);
  }, 30_000);

  it.each([
    { earlier: 'refused', own: 'failed in transport', outcome: 'retry' },
    { earlier: 'failed in transport', own: 'refused', outcome: 'stop' },
  ] as const)('judges a recovery attempt by its own fetch when a refresh still running before it is $earlier', async ({ earlier, outcome }) => {
    agent = await startMember('JoinMetadataEarlierRefresh');
    const contextGraphId = 'join-metadata-earlier-refresh';
    const member = approve(agent, contextGraphId, { onChainId: '582' });
    const foreign = curatorSnapshot(contextGraphId, member, agent.peerId, '323');
    const answers = earlier === 'refused'
      ? [foreign, new Error(TRANSPORT_FAILURE)]
      : [new Error(TRANSPORT_FAILURE), foreign];
    let releaseEarlier!: () => void;
    const earlierHeld = new Promise<void>((resolve) => { releaseEarlier = resolve; });
    const calls = reachCurator(agent, contextGraphId, async (attempt) => {
      if (attempt === 1) await earlierHeld;
      return answers[attempt - 1]!;
    });
    vi.spyOn(agent, 'runImmediatePostApprovalSync').mockResolvedValue(undefined);
    const refresh = vi.spyOn(agent, 'refreshMetaFromCurator');

    // A refresh of the same graph and curator is still fetching when the
    // attempt starts; the attempt's own refresh waits behind it.
    const running = agent.refreshMetaFromCurator(contextGraphId, {
      trustedCuratorPeerId: CURATOR_PEER,
      force: true,
      approvedMember: await agent.resolveApprovedMemberAcceptance(contextGraphId),
    });
    await vi.waitFor(() => expect(calls.metadataFetches).toBe(1));
    const attempt = agent.resumePendingJoinApprovalMetadata(contextGraphId, CURATOR_PEER);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    releaseEarlier();

    await expect(running).resolves.toBe(false);
    await expect(attempt).resolves.toBe(outcome);
    expect(calls.metadataFetches).toBe(2);
  }, 30_000);

  it.each([
    { change: 'the row gains another registration', counted: true },
    { change: 'the graph turns public', counted: false },
  ])('counts a refusal during the install only when $change', async ({ counted }) => {
    agent = await startMember('JoinMetadataActivationRefusal');
    const contextGraphId = 'join-metadata-activation-refusal';
    const member = approve(agent, contextGraphId);
    reachCurator(agent, contextGraphId, () => (
      curatorSnapshot(contextGraphId, member, agent!.peerId, '323')
    ));
    // The snapshot is admitted and then refused at its activation: the third
    // authority read is the activation's.
    let authorityReads = 0;
    const running = agent;
    const acceptance = await resolveApprovedMemberAcceptanceDecision(
      { approvedAgentAddress: member, expectedDelegateePeerId: agent.peerId },
      async () => {
        authorityReads += 1;
        if (authorityReads < 3) return { kind: 'private-roster' as const, participantAgents: [] };
        if (!counted) return { kind: 'plaintext' as const };
        internalsOf(running).subscribedContextGraphs.set(contextGraphId, {
          ...running.getSubscribedContextGraphs().get(contextGraphId)!,
          onChainId: '582',
        });
        return { kind: 'private-roster' as const, participantAgents: [] };
      },
    );
    const refused = watchCuratorRegistrationRefusal(agent, contextGraphId, CURATOR_PEER);
    const refusedByAnotherPeer = watchCuratorRegistrationRefusal(
      agent,
      contextGraphId,
      '12D3KooWAnotherCuratorPeer',
    );

    await expect(agent.refreshMetaFromCurator(contextGraphId, {
      trustedCuratorPeerId: CURATOR_PEER,
      force: true,
      approvedMember: acceptance,
    })).resolves.toBe(false);

    expect(authorityReads).toBe(3);
    await expect(agent.contextGraphExists(contextGraphId)).resolves.toBe(false);
    expect(refused()).toBe(counted);
    expect(refusedByAnotherPeer()).toBe(false);
    // A watch that starts afterwards does not see the earlier refusal.
    expect(watchCuratorRegistrationRefusal(agent, contextGraphId, CURATOR_PEER)()).toBe(false);
  }, 30_000);

  describe('after the post-approval sync', () => {
    const contextGraphId = 'join-metadata-after-sync';
    const dialAddress = `/ip4/127.0.0.1/tcp/9090/p2p/${CURATOR_PEER}`;

    /** An approved member whose sync, confirmation and recovery are observed. */
    async function approvedMember(metadataConfirmed: boolean) {
      agent = await DKGAgent.create({
        name: 'JoinMetadataAfterSync',
        chainAdapter: new MockChainAdapter(),
      });
      const member = '0x00000000000000000000000000000000000000a1';
      internalsOf(agent).localApprovedAgentByCG.set(contextGraphId, member);
      internalsOf(agent).subscribedContextGraphs.set(contextGraphId, {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        pendingMeta: true,
        syncMode: 'always-on',
      });
      const acceptance = unprovenApprovedMemberAcceptance({
        approvedAgentAddress: member,
        expectedDelegateePeerId: '12D3KooWJoinMetadataAfterSyncMember',
      });
      return {
        member: agent,
        acceptance,
        sync: vi.spyOn(agent, 'runImmediatePostApprovalSync').mockResolvedValue(undefined),
        resolveAcceptance: vi.spyOn(agent, 'resolveApprovedMemberAcceptance')
          .mockResolvedValue(acceptance),
        confirmed: vi.spyOn(agent, 'hasConfirmedApprovedMemberMetaState')
          .mockResolvedValue(metadataConfirmed),
        recover: vi.spyOn(agent, 'recoverPendingJoinApprovalMetadata').mockResolvedValue(undefined),
      };
    }
    type Observed = Awaited<ReturnType<typeof approvedMember>>;

    it('leaves a join alone once its sync confirmed the metadata', async () => {
      const { member, acceptance, sync, confirmed, recover } = await approvedMember(true);

      await runPostApprovalSyncWithMetadataRecovery(member, contextGraphId, CURATOR_PEER, dialAddress);

      expect(sync).toHaveBeenCalledWith(contextGraphId, CURATOR_PEER);
      expect(confirmed).toHaveBeenCalledWith(contextGraphId, acceptance);
      expect(recover).not.toHaveBeenCalled();
    });

    it('continues with the bounded recovery when the sync ended without the metadata', async () => {
      const { member, sync, recover } = await approvedMember(false);

      await runPostApprovalSyncWithMetadataRecovery(member, contextGraphId, CURATOR_PEER, dialAddress);

      expect(sync).toHaveBeenCalledTimes(1);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(recover).toHaveBeenCalledWith(contextGraphId, CURATOR_PEER, dialAddress);
    });

    it.each([
      { failing: 'the sync throws', arrange: (m: Observed) => m.sync.mockRejectedValue(new Error('no curator route')) },
      { failing: 'the approval binding read fails', arrange: (m: Observed) => m.resolveAcceptance.mockRejectedValue(new Error('store fault')) },
      { failing: 'the confirmation read fails', arrange: (m: Observed) => m.confirmed.mockRejectedValue(new Error('store fault')) },
    ])('continues with the recovery when $failing', async ({ arrange }) => {
      const observed = await approvedMember(false);
      arrange(observed);

      await runPostApprovalSyncWithMetadataRecovery(observed.member, contextGraphId, CURATOR_PEER);

      expect(observed.recover).toHaveBeenCalledWith(contextGraphId, CURATOR_PEER, undefined);
    });

    it('retries with backoff until an attempt completes', async () => {
      const { member, recover } = await approvedMember(false);
      recover.mockRestore();
      const attempt = vi.spyOn(member, 'resumePendingJoinApprovalMetadata')
        .mockResolvedValueOnce('retry')
        .mockResolvedValueOnce('retry')
        .mockResolvedValueOnce('completed');
      vi.useFakeTimers();

      const running = runPostApprovalSyncWithMetadataRecovery(member, contextGraphId, CURATOR_PEER, dialAddress);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempt).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(attempt).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_000);
      await running;

      expect(attempt).toHaveBeenCalledTimes(3);
      expect(attempt).toHaveBeenLastCalledWith(contextGraphId, CURATOR_PEER, dialAddress);
    });

    it('runs one recovery for a graph and curator at a time, and once more for a request it skipped', async () => {
      const { member, sync, recover } = await approvedMember(false);
      const finish: Array<() => void> = [];
      recover.mockImplementation(() => new Promise<void>((resolve) => { finish.push(resolve); }));

      // A restart started the recovery; an approval for the same graph and
      // curator arrives while it runs, and its own sync fetches nothing.
      const first = runJoinApprovalMetadataRecovery(member, contextGraphId, CURATOR_PEER);
      expect(recover).toHaveBeenCalledTimes(1);
      await runPostApprovalSyncWithMetadataRecovery(member, contextGraphId, CURATOR_PEER, dialAddress);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(recover).toHaveBeenCalledTimes(1);
      // An approval sent by another curator peer is a recovery of its own.
      const other = runPostApprovalSyncWithMetadataRecovery(member, contextGraphId, '12D3KooWAnotherCuratorPeer');
      await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
      finish[1]!();
      await other;

      // The skipped request is not dropped: when the running recovery ends it
      // runs once more, with the dial address the later approval brought.
      finish[0]!();
      await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(3));
      expect(recover).toHaveBeenLastCalledWith(contextGraphId, CURATOR_PEER, dialAddress);
      finish[2]!();
      await first;

      // Once it ended, a later request starts a new one.
      recover.mockResolvedValue(undefined);
      await runJoinApprovalMetadataRecovery(member, contextGraphId, CURATOR_PEER);
      expect(recover).toHaveBeenCalledTimes(4);
    });

    it('does not run once more for a skipped request after the node stopped', async () => {
      const { member, recover } = await approvedMember(false);
      const stop = new AbortController();
      Object.defineProperty(member.node, 'stopSignal', { get: () => stop.signal, configurable: true });
      let finish!: () => void;
      recover.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));

      const first = runJoinApprovalMetadataRecovery(member, contextGraphId, CURATOR_PEER);
      await runJoinApprovalMetadataRecovery(member, contextGraphId, CURATOR_PEER);
      stop.abort();
      finish();
      await first;

      expect(recover).toHaveBeenCalledTimes(1);
    });

    it('starts no recovery once the approval is withdrawn', async () => {
      const { member, resolveAcceptance, recover } = await approvedMember(false);

      // The approval binding is gone.
      resolveAcceptance.mockResolvedValueOnce(undefined);
      await runPostApprovalSyncWithMetadataRecovery(member, contextGraphId, CURATOR_PEER);
      // The node left the graph while the sync ran.
      internalsOf(member).subscribedContextGraphs.set(contextGraphId, {
        ...member.getSubscribedContextGraphs().get(contextGraphId)!,
        subscribed: false,
      });
      await runPostApprovalSyncWithMetadataRecovery(member, contextGraphId, CURATOR_PEER);

      expect(recover).not.toHaveBeenCalled();
    });

    it('starts no recovery once the node stops', async () => {
      const { member, sync, recover } = await approvedMember(false);
      const stop = new AbortController();
      Object.defineProperty(member.node, 'stopSignal', { get: () => stop.signal, configurable: true });
      sync.mockImplementation(async () => { stop.abort(); });

      await runPostApprovalSyncWithMetadataRecovery(member, contextGraphId, CURATOR_PEER);

      expect(recover).not.toHaveBeenCalled();
    });

    it('does not reject when the recovery itself fails', async () => {
      const { member, recover } = await approvedMember(false);
      recover.mockRejectedValue(new Error('store fault'));

      await expect(runPostApprovalSyncWithMetadataRecovery(member, contextGraphId, CURATOR_PEER))
        .resolves.toBeUndefined();
      // The failed recovery released its slot.
      recover.mockResolvedValue(undefined);
      await runPostApprovalSyncWithMetadataRecovery(member, contextGraphId, CURATOR_PEER);
      expect(recover).toHaveBeenCalledTimes(2);
    });

    it('ends an attempt whose node finished stopping while it ran', async () => {
      const { member, sync } = await approvedMember(true);
      // A node that finished stopping no longer exposes its stop signal.
      const stop = new AbortController();
      let stopped = false;
      Object.defineProperty(member.node, 'stopSignal', {
        get: () => (stopped ? undefined : stop.signal),
        configurable: true,
      });
      vi.spyOn(member, 'refreshMetaFromCurator').mockResolvedValue(true);
      vi.spyOn(member, 'resolveContextGraphReadAuthority').mockImplementation(async () => {
        stop.abort();
        stopped = true;
        return {
          outcome: 'allowed',
          source: 'registered-chain',
          reason: 'chain-participant',
          metadataBootstrap: 'eligible',
        };
      });
      const refreshFlags = vi.spyOn(member, 'refreshMetaSyncedFlags').mockResolvedValue(undefined);
      const subscribe = vi.spyOn(member, 'subscribeToContextGraph').mockImplementation(
        () => member.getSubscribedContextGraphs().get(contextGraphId)!,
      );
      vi.spyOn(member, 'persistLocalNodeMembership').mockImplementation(() => undefined);

      await expect(member.resumePendingJoinApprovalMetadata(contextGraphId, CURATOR_PEER))
        .resolves.toBe('stop');

      expect(refreshFlags).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
    });
  });
});
