import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MockChainAdapter,
  type ContextGraphAuthorityProjectionServedEvidence,
  type ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';

const MEMBER = '0x0000000000000000000000000000000000000001';
const NON_MEMBER = '0x00000000000000000000000000000000000000ff';

const registeredBinding = (onChainId: bigint) => ({
  kind: 'registered' as const,
  onChainId,
  provenance: 'authoritative' as const,
});

/** What the current-state read reports on a slow public RPC pool. */
const LIVE_TIMEOUT = {
  kind: 'unavailable' as const,
  reason: 'chain-access-policy-timeout' as const,
};

function finalizedAuthoritySnapshot(
  contextGraphId: bigint,
  nameHash: string,
  overrides: Partial<ContextGraphAuthoritySnapshot> = {},
): ContextGraphAuthoritySnapshot {
  return {
    chainId: '20430',
    governanceContract: `0x${'11'.repeat(20)}`,
    contextGraphId: contextGraphId.toString(10),
    owner: `0x${'22'.repeat(20)}`,
    active: true,
    accessPolicy: 0,
    publishPolicy: 0,
    publishAuthority: `0x${'22'.repeat(20)}`,
    publishAuthorityAccountId: '1',
    participantAgents: [],
    nameHash,
    ownershipEra: '1',
    policyVersion: '1',
    rosterVersion: '1',
    sourceBlockNumber: '100',
    sourceBlockHash: `0x${'33'.repeat(32)}`,
    ...overrides,
  };
}

/**
 * A finalized index that holds exactly `snapshots`; every other id is absent.
 * Like the EVM reader, it reports how the projection was served: a fresh cache
 * hit unless the test says otherwise (`served: null` models an adapter that
 * reports nothing). A private roster is consumed only on fresh provenance.
 */
function installFinalizedAuthorityReader(
  chain: MockChainAdapter,
  snapshots: readonly ContextGraphAuthoritySnapshot[],
  served: ContextGraphAuthorityProjectionServedEvidence | null = { source: 'cache', ageMs: 0 },
) {
  const readContextGraphAuthorityIndexSnapshots = vi.fn(async (
    contextGraphIds: readonly string[],
    options?: {
      signal?: AbortSignal;
      onContextGraphAuthorityProjectionServed?: (
        report: ContextGraphAuthorityProjectionServedEvidence,
      ) => void;
    },
  ) => {
    if (served !== null) options?.onContextGraphAuthorityProjectionServed?.(served);
    return new Map(snapshots
      .filter((snapshot) => contextGraphIds.includes(snapshot.contextGraphId))
      .map((snapshot) => [snapshot.contextGraphId, snapshot] as const));
  });
  Reflect.set(chain, 'contextGraphAuthorityIndexRevisionReader', {
    readContextGraphAuthorityIndexSnapshots,
    readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
    whenIdle: vi.fn(async () => undefined),
  });
  return readContextGraphAuthorityIndexSnapshots;
}

describe('finalized authority on the SWM host/sync and share paths', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (agent) await agent.stop().catch(() => undefined);
    agent = null;
  });

  it('decides SWM host/sync admission from the finalized snapshot without a live RPC', async () => {
    const contextGraphId = 'finalized-swm-sync';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FinalizedSwmSyncGate', chainAdapter: chain });
    vi.spyOn(agent, 'resolveAcceptedRfc64SharedMemoryAuthorityV1').mockReturnValue(undefined);
    vi.spyOn(agent, 'hasConfirmedSharedMemoryMetaState').mockResolvedValue(true);
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
    // Served fresh (a cache hit inside the tick), so the private roster decides.
    const readIndex = installFinalizedAuthorityReader(chain, [
      finalizedAuthoritySnapshot(7n, agent.contextGraphNameCommitment(contextGraphId), {
        accessPolicy: 1,
        participantAgents: [MEMBER],
      }),
    ]);
    // The current-state read would fail closed on this pool; the gate must
    // not need it while the finalized snapshot answers.
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState')
      .mockResolvedValue(LIVE_TIMEOUT);
    const pointRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents');

    await expect(agent.canUseSharedMemoryForContextGraph(contextGraphId, {
      callerAgentAddress: MEMBER,
    })).resolves.toBe(true);
    await expect(agent.canUseSharedMemoryForContextGraph(contextGraphId, {
      callerAgentAddress: NON_MEMBER,
    })).resolves.toBe(false);
    expect(readIndex).toHaveBeenCalledTimes(2);
    expect(live).not.toHaveBeenCalled();
    expect(pointRoster).not.toHaveBeenCalled();
  });

  it('reaches the current-state read when the index has no snapshot, never on mismatched evidence', async () => {
    const contextGraphId = 'finalized-swm-sync-fallback';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FinalizedSwmSyncFallback', chainAdapter: chain });
    vi.spyOn(agent, 'resolveAcceptedRfc64SharedMemoryAuthorityV1').mockReturnValue(undefined);
    vi.spyOn(agent, 'hasConfirmedSharedMemoryMetaState').mockResolvedValue(true);
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState')
      .mockResolvedValue({ kind: 'available', accessPolicy: 1 });
    const pointRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents')
      .mockResolvedValue([MEMBER]);

    // No snapshot at the finalized anchor (registered inside the finality
    // window): the bounded current-state read owns the answer.
    installFinalizedAuthorityReader(chain, []);
    await expect(agent.canUseSharedMemoryForContextGraph(contextGraphId, {
      callerAgentAddress: MEMBER,
    })).resolves.toBe(true);
    expect(live).toHaveBeenCalledTimes(1);
    expect(pointRoster).toHaveBeenCalledTimes(1);

    // A snapshot whose name commitment is not this graph's is affirmative
    // evidence against the local mapping: fail closed, no live fallback.
    installFinalizedAuthorityReader(chain, [
      finalizedAuthoritySnapshot(7n, `0x${'44'.repeat(32)}`, {
        accessPolicy: 1,
        participantAgents: [MEMBER],
      }),
    ]);
    await expect(agent.canUseSharedMemoryForContextGraph(contextGraphId, {
      callerAgentAddress: MEMBER,
    })).resolves.toBe(false);
    expect(live).toHaveBeenCalledTimes(1);
    expect(pointRoster).toHaveBeenCalledTimes(1);

    // An inactive snapshot is evidence too.
    installFinalizedAuthorityReader(chain, [
      finalizedAuthoritySnapshot(7n, agent.contextGraphNameCommitment(contextGraphId), {
        active: false,
        accessPolicy: 1,
        participantAgents: [MEMBER],
      }),
    ]);
    await expect(agent.canUseSharedMemoryForContextGraph(contextGraphId, {
      callerAgentAddress: MEMBER,
    })).resolves.toBe(false);
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('resolves both policy bits for the share and host-mode gates from the finalized snapshot without RPC', async () => {
    const publicOpen = 'finalized-policy-public-open';
    const absent = 'finalized-policy-absent';
    const stale = 'finalized-policy-stale';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FinalizedPolicyBits', chainAdapter: chain });
    for (const [contextGraphId, onChainId] of [[publicOpen, '8'], [absent, '9'], [stale, '10']] as const) {
      agent.setContextGraphSubscription(contextGraphId, {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        onChainId,
        onChainHash: agent.contextGraphNameCommitment(contextGraphId),
      }, { persist: false });
    }
    // Open contribution: the finalized publish domain carries no authority.
    const openPublishDomain = {
      publishPolicy: 1,
      publishAuthority: null,
      publishAuthorityAccountId: '0',
    } as const;
    const readIndex = installFinalizedAuthorityReader(chain, [
      finalizedAuthoritySnapshot(8n, agent.contextGraphNameCommitment(publicOpen), {
        accessPolicy: 0,
        ...openPublishDomain,
      }),
      // Committed to some other name: a reused slot behind a stale mapping.
      finalizedAuthoritySnapshot(10n, `0x${'44'.repeat(32)}`, {
        accessPolicy: 0,
        ...openPublishDomain,
      }),
    ]);
    const publishRpc = vi.spyOn(chain, 'getContextGraphPublishPolicy');
    const accessRpc = vi.spyOn(chain, 'getContextGraphAccessPolicy');

    // Both bits come from the one name-bound snapshot; no point RPC is made.
    await expect(agent.getContextGraphOnChainPolicy(publicOpen))
      .resolves.toEqual({ accessPolicy: 0, publishPolicy: 1 });
    expect(readIndex).toHaveBeenCalledWith(
      ['8'],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(publishRpc).not.toHaveBeenCalled();
    expect(accessRpc).not.toHaveBeenCalled();
    // The security-positive host-mode gate is served by the same answer.
    await expect(agent.isConfirmedPublicForHostMode(publicOpen)).resolves.toBe(true);
    expect(publishRpc).not.toHaveBeenCalled();

    // No snapshot at all: the current-state RPC reads remain the fallback.
    await expect(agent.getContextGraphOnChainPolicy(absent))
      .resolves.toEqual({ accessPolicy: 0, publishPolicy: 0 });
    expect(publishRpc).toHaveBeenCalledTimes(1);
    expect(publishRpc).toHaveBeenCalledWith(9n);
    expect(accessRpc).toHaveBeenCalledTimes(1);
    expect(accessRpc).toHaveBeenCalledWith(9n);

    // Mismatched evidence stays UNKNOWN and never pays the RPC fallback.
    await expect(agent.getContextGraphOnChainPolicy(stale)).resolves.toEqual({});
    await expect(agent.isConfirmedPublicForHostMode(stale)).resolves.toBe(false);
    expect(publishRpc).toHaveBeenCalledTimes(1);
    expect(accessRpc).toHaveBeenCalledTimes(1);
  });

  it('shares plaintext into a finalized public graph without a live read and keeps the private roster live', async () => {
    const publicGraph = 'finalized-share-public';
    const privateGraph = 'finalized-share-private';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FinalizedShareRecipients', chainAdapter: chain });
    const member = await agent.registerAgent('Finalized private member');
    const registration = vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(11n));
    installFinalizedAuthorityReader(chain, [
      finalizedAuthoritySnapshot(11n, agent.contextGraphNameCommitment(publicGraph)),
      // A PRIVATE snapshot proves the policy bit only; its roster is a decoy
      // that the encryption path must never consume, even served fresh.
      finalizedAuthoritySnapshot(12n, agent.contextGraphNameCommitment(privateGraph), {
        accessPolicy: 1,
        participantAgents: [NON_MEMBER],
      }),
    ]);
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState')
      .mockResolvedValue(LIVE_TIMEOUT);
    vi.spyOn(agent, 'getContextGraphAllowedPeers').mockResolvedValue(null);

    await expect(agent.resolveWorkspaceAgentRecipientsForCurrentAuthority({
      contextGraphId: publicGraph,
    })).resolves.toEqual({ requiresEncryption: false, recipients: [] });
    expect(live).not.toHaveBeenCalled();

    registration.mockResolvedValue(registeredBinding(12n));
    live.mockResolvedValue({
      kind: 'available',
      accessPolicy: 1,
      participantAgents: [member.agentAddress],
    });
    const resolution = await agent.resolveWorkspaceAgentRecipientsForCurrentAuthority({
      contextGraphId: privateGraph,
    });
    expect(live).toHaveBeenCalledTimes(1);
    expect(resolution.requiresEncryption).toBe(true);
    expect(resolution.recipients.map((recipient) => recipient.agentAddress.toLowerCase()))
      .toEqual([member.agentAddress.toLowerCase()]);
  });

  it('admits host-mode gossip from the finalized roster without a live RPC', async () => {
    const contextGraphId = 'finalized-host-gossip';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FinalizedHostGossipRoster', chainAdapter: chain });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(13n));
    // Served fresh (a cache hit inside the tick), so the private roster decides.
    installFinalizedAuthorityReader(chain, [
      finalizedAuthoritySnapshot(13n, agent.contextGraphNameCommitment(contextGraphId), {
        accessPolicy: 1,
        participantAgents: [MEMBER],
      }),
    ]);
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState')
      .mockResolvedValue(LIVE_TIMEOUT);
    const pointRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents');

    await expect(agent.resolveOnChainParticipantAgents(contextGraphId)).resolves.toEqual([MEMBER]);
    expect(live).not.toHaveBeenCalled();
    expect(pointRoster).not.toHaveBeenCalled();
  });

  it('takes a private roster the reader could not serve fresh to the live roster read on the read-only gates', async () => {
    const contextGraphId = 'finalized-stale-roster-gates';
    const REMAINING_MEMBER = '0x0000000000000000000000000000000000000002';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FinalizedStaleRosterGates', chainAdapter: chain });
    vi.spyOn(agent, 'resolveAcceptedRfc64SharedMemoryAuthorityV1').mockReturnValue(undefined);
    vi.spyOn(agent, 'hasConfirmedSharedMemoryMetaState').mockResolvedValue(true);
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(14n));
    const nameHash = agent.contextGraphNameCommitment(contextGraphId);
    const privateSnapshot = finalizedAuthoritySnapshot(14n, nameHash, {
      accessPolicy: 1,
      participantAgents: [MEMBER],
    });
    // MEMBER was removed on chain after the retained projection was fetched.
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState').mockResolvedValue({
      kind: 'available',
      accessPolicy: 1,
      participantAgents: [REMAINING_MEMBER],
    });

    // `stale-cache` is the reader saying a refresh failed and the projection
    // is at least one tick old; an unreported provenance proves nothing.
    // Neither the SWM host/sync gate nor the host-mode gossip oracle may admit
    // from that roster: both take the current one from the live read.
    const notFresh: Array<ContextGraphAuthorityProjectionServedEvidence | null> = [
      { source: 'stale-cache', ageMs: 5_000 },
      null,
    ];
    for (const [index, served] of notFresh.entries()) {
      const readIndex = installFinalizedAuthorityReader(chain, [privateSnapshot], served);
      await expect(agent.canUseSharedMemoryForContextGraph(contextGraphId, {
        callerAgentAddress: MEMBER,
      })).resolves.toBe(false);
      await expect(agent.resolveOnChainParticipantAgents(contextGraphId))
        .resolves.toEqual([REMAINING_MEMBER]);
      expect(readIndex).toHaveBeenCalledTimes(2);
      expect(live).toHaveBeenCalledTimes((index + 1) * 2);
    }

    // The same projection served fresh decides without the live read.
    const freshRead = installFinalizedAuthorityReader(chain, [privateSnapshot], {
      source: 'scan',
      ageMs: 0,
    });
    await expect(agent.canUseSharedMemoryForContextGraph(contextGraphId, {
      callerAgentAddress: MEMBER,
    })).resolves.toBe(true);
    await expect(agent.resolveOnChainParticipantAgents(contextGraphId)).resolves.toEqual([MEMBER]);
    expect(freshRead).toHaveBeenCalledTimes(2);
    expect(live).toHaveBeenCalledTimes(notFresh.length * 2);

    // The policy bit is immutable on chain: a public snapshot answers the gate
    // at any provenance.
    installFinalizedAuthorityReader(
      chain,
      [finalizedAuthoritySnapshot(14n, nameHash)],
      { source: 'stale-cache', ageMs: 600_000 },
    );
    await expect(agent.canUseSharedMemoryForContextGraph(contextGraphId, {
      callerAgentAddress: NON_MEMBER,
    })).resolves.toBe(true);
    expect(live).toHaveBeenCalledTimes(notFresh.length * 2);
  });
});
