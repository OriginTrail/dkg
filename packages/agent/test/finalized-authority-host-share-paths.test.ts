import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MockChainAdapter,
  type ContextGraphAuthorityProjectionServedEvidence,
  type ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  encodeWorkspacePublishRequest,
} from '@origintrail-official/dkg-core';
import { DKGAgent, agentFromPrivateKey, type AgentKeyRecord } from '../src/index.js';
import { initializeRfc64LegacySwmBoundaryV1 } from '../src/rfc64/legacy-swm-boundary-v1.js';
import { resolveRfc64PersistenceRootV1 } from '../src/rfc64/persistence-layout-v1.js';
import { SwmHostModeStore } from '../src/swm/host-mode-store.js';

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

/** Open contribution: the finalized publish domain carries no authority. */
const OPEN_PUBLISH_DOMAIN = {
  publishPolicy: 1,
  publishAuthority: null,
  publishAuthorityAccountId: '0',
} as const;

/** The current-state publish read after the owner switched open → curated. */
const LIVE_CURATED_PUBLISH = { publishPolicy: 0, publishAuthority: `0x${'22'.repeat(20)}` };

/** The window `isConfirmedPublicForHostMode` accepts for the mutable publish bit. */
const HOST_MODE_PUBLISH_WINDOW_MS = 5_000;

/** What a reader serves after its refresh failed: minutes old at worst. */
const STALE_CACHE: ContextGraphAuthorityProjectionServedEvidence = {
  source: 'stale-cache',
  ageMs: 17_000,
};

function bindOnChainId(agent: DKGAgent, contextGraphId: string, onChainId: bigint): void {
  agent.setContextGraphSubscription(contextGraphId, {
    subscribed: true,
    synced: false,
    sharedMemorySynced: false,
    metaSynced: false,
    onChainId: onChainId.toString(10),
    onChainHash: agent.contextGraphNameCommitment(contextGraphId),
  }, { persist: false });
}

/** A public, open-publish snapshot committed to `contextGraphId`. */
function openSnapshot(agent: DKGAgent, contextGraphId: string, onChainId: bigint) {
  return finalizedAuthoritySnapshot(onChainId, agent.contextGraphNameCommitment(contextGraphId), {
    accessPolicy: 0,
    ...OPEN_PUBLISH_DOMAIN,
  });
}

interface HostModeIngestInternals {
  swmHostModeStore?: SwmHostModeStore;
  localAgents: Map<string, AgentKeyRecord>;
  defaultAgentAddress?: string;
  encodeWorkspaceGossipMessage(
    contextGraphId: string,
    message: Uint8Array,
    resolvedSigner?: AgentKeyRecord & { privateKey: string },
  ): Promise<Uint8Array>;
  ingestSwmHostModeEnvelope(contextGraphId: string, data: Uint8Array, fromPeerId: string): Promise<void>;
  getSwmHostModeStats(): Promise<{ perCg?: Record<string, { entries: number }> } | undefined>;
}

const PUBLISHER_PEER = '12D3KooWFinalizedPublishPolicyPublisherPeer';

describe('the mutable publish policy bit from the finalized authority index', () => {
  let agent: DKGAgent | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    if (agent) {
      await agent.stop().catch(() => undefined);
      await agent.store.close().catch(() => undefined);
    }
    agent = null;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('does not admit on the host-mode gate from a publish bit the reader could not serve fresh', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FinalizedPublishNotFresh', chainAdapter: chain });
    // The owner switched each graph from open to curated publish after the
    // retained projection was fetched; the current-state read already says so.
    const publishRpc = vi.spyOn(chain, 'getContextGraphPublishPolicy')
      .mockResolvedValue(LIVE_CURATED_PUBLISH);
    const accessRpc = vi.spyOn(chain, 'getContextGraphAccessPolicy');
    // `stale-cache` is a projection served DESPITE a failed refresh; a reader
    // that reports no provenance proves nothing about the data's age.
    const notFresh: Array<[string, bigint, ContextGraphAuthorityProjectionServedEvidence | null]> = [
      ['finalized-publish-stale-cache', 20n, STALE_CACHE],
      ['finalized-publish-unreported', 21n, null],
    ];
    for (const [index, [contextGraphId, onChainId, served]] of notFresh.entries()) {
      bindOnChainId(agent, contextGraphId, onChainId);
      const readIndex = installFinalizedAuthorityReader(
        chain,
        [openSnapshot(agent, contextGraphId, onChainId)],
        served,
      );

      await expect(agent.isConfirmedPublicForHostMode(contextGraphId)).resolves.toBe(false);
      expect(readIndex).toHaveBeenCalledTimes(1);
      expect(publishRpc).toHaveBeenCalledTimes(index + 1);
      expect(publishRpc).toHaveBeenLastCalledWith(onChainId);
      // What the gate saw: the immutable access bit from the snapshot, the
      // publish bit from the current-state read.
      await expect(agent.getContextGraphOnChainPolicy(contextGraphId, {
        publishPolicyMaxCacheAgeMs: HOST_MODE_PUBLISH_WINDOW_MS,
      })).resolves.toEqual({ accessPolicy: 0, publishPolicy: 0 });
      expect(accessRpc).not.toHaveBeenCalled();
    }
  });

  it('leaves a stale publish bit unknown when the current-state read fails, and never caches it', async () => {
    const contextGraphId = 'finalized-publish-stale-rpc-down';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FinalizedPublishStaleRpcDown', chainAdapter: chain });
    bindOnChainId(agent, contextGraphId, 22n);
    installFinalizedAuthorityReader(chain, [openSnapshot(agent, contextGraphId, 22n)], STALE_CACHE);
    const publishRpc = vi.spyOn(chain, 'getContextGraphPublishPolicy')
      .mockRejectedValue(new Error('every configured endpoint is rate limited'));

    // Unknown fails closed on every consumer.
    await expect(agent.getContextGraphOnChainPolicy(contextGraphId))
      .resolves.toEqual({ accessPolicy: 0 });
    await expect(agent.isConfirmedPublicForHostMode(contextGraphId)).resolves.toBe(false);
    // The stale bit was never cached, so each call asked the chain again.
    expect(publishRpc).toHaveBeenCalledTimes(2);
  });

  it('answers both bits from a projection served fresh inside the caller bound, without RPC', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FinalizedPublishFresh', chainAdapter: chain });
    const publishRpc = vi.spyOn(chain, 'getContextGraphPublishPolicy');
    const accessRpc = vi.spyOn(chain, 'getContextGraphAccessPolicy');
    const fresh: Array<[string, bigint, ContextGraphAuthorityProjectionServedEvidence]> = [
      ['finalized-publish-scan', 23n, { source: 'scan', ageMs: 250 }],
      ['finalized-publish-young-cache', 24n, { source: 'cache', ageMs: 4_000 }],
      ['finalized-publish-young-log', 25n, { source: 'log', ageMs: 4_000 }],
    ];
    for (const [contextGraphId, onChainId, served] of fresh) {
      bindOnChainId(agent, contextGraphId, onChainId);
      installFinalizedAuthorityReader(chain, [openSnapshot(agent, contextGraphId, onChainId)], served);
      await expect(agent.isConfirmedPublicForHostMode(contextGraphId)).resolves.toBe(true);
    }
    expect(publishRpc).not.toHaveBeenCalled();
    expect(accessRpc).not.toHaveBeenCalled();
  });

  it('takes only the publish bit of a projection older than the caller accepts from the current-state read', async () => {
    const hostGate = 'finalized-publish-aged-host-gate';
    const defaultCaller = 'finalized-publish-aged-default';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FinalizedPublishAged', chainAdapter: chain });
    bindOnChainId(agent, hostGate, 26n);
    bindOnChainId(agent, defaultCaller, 27n);
    // Still inside the reader's 6 s tick, so served as `cache`, but older than
    // the window the host-mode gate accepts for the mutable bit.
    const readIndex = installFinalizedAuthorityReader(chain, [
      openSnapshot(agent, hostGate, 26n),
      openSnapshot(agent, defaultCaller, 27n),
    ], { source: 'cache', ageMs: 5_500 });
    const publishRpc = vi.spyOn(chain, 'getContextGraphPublishPolicy')
      .mockResolvedValue(LIVE_CURATED_PUBLISH);
    const accessRpc = vi.spyOn(chain, 'getContextGraphAccessPolicy');

    await expect(agent.getContextGraphOnChainPolicy(hostGate, {
      publishPolicyMaxCacheAgeMs: HOST_MODE_PUBLISH_WINDOW_MS,
    })).resolves.toEqual({ accessPolicy: 0, publishPolicy: 0 });
    expect(publishRpc).toHaveBeenCalledTimes(1);
    expect(publishRpc).toHaveBeenCalledWith(26n);
    expect(accessRpc).not.toHaveBeenCalled();

    // The bound is the caller's: the same projection is young enough for a
    // caller on the default 60 s publish-policy TTL.
    await expect(agent.getContextGraphOnChainPolicy(defaultCaller))
      .resolves.toEqual({ accessPolicy: 0, publishPolicy: 1 });
    expect(readIndex).toHaveBeenCalledTimes(2);
    expect(publishRpc).toHaveBeenCalledTimes(1);
    expect(accessRpc).not.toHaveBeenCalled();
  });

  it('dates a consumed finalized publish bit by its observation, so the local cache cannot extend its age', async () => {
    const contextGraphId = 'finalized-publish-cache-dating';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FinalizedPublishCacheDating', chainAdapter: chain });
    bindOnChainId(agent, contextGraphId, 28n);
    const readIndex = installFinalizedAuthorityReader(
      chain,
      [openSnapshot(agent, contextGraphId, 28n)],
      { source: 'cache', ageMs: 4_000 },
    );
    const publishRpc = vi.spyOn(chain, 'getContextGraphPublishPolicy');
    vi.useFakeTimers({ toFake: ['Date'] });

    await expect(agent.isConfirmedPublicForHostMode(contextGraphId)).resolves.toBe(true);
    expect(readIndex).toHaveBeenCalledTimes(1);
    // 1.5 s later the cached bit's data is 5.5 s old, past the gate's window:
    // the gate asks the index again instead of trusting the local cache.
    vi.setSystemTime(Date.now() + 1_500);
    await expect(agent.isConfirmedPublicForHostMode(contextGraphId)).resolves.toBe(true);
    expect(readIndex).toHaveBeenCalledTimes(2);
    expect(publishRpc).not.toHaveBeenCalled();
  });

  it('still consumes the immutable access bit from a projection served as stale-cache', async () => {
    const contextGraphId = 'finalized-access-stale-cache';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FinalizedAccessStaleCache', chainAdapter: chain });
    bindOnChainId(agent, contextGraphId, 29n);
    // At the reader's outer stale bound (5 min), a PRIVATE graph.
    installFinalizedAuthorityReader(chain, [
      finalizedAuthoritySnapshot(29n, agent.contextGraphNameCommitment(contextGraphId), {
        accessPolicy: 1,
        participantAgents: [MEMBER],
      }),
    ], { source: 'stale-cache', ageMs: 300_000 });
    const accessRpc = vi.spyOn(chain, 'getContextGraphAccessPolicy');

    const policy = await agent.getContextGraphOnChainPolicy(contextGraphId);
    expect(policy.accessPolicy).toBe(1);
    expect(accessRpc).not.toHaveBeenCalled();
  });

  describe('host-mode self-signed plaintext ingest', () => {
    async function createHostModeCore(chain: MockChainAdapter): Promise<DKGAgent> {
      const dataDir = await mkdtemp(join(tmpdir(), 'dkg-finalized-publish-policy-'));
      tempDirs.push(dataDir);
      const core = await DKGAgent.create({
        name: 'FinalizedPublishHostIngest',
        chainAdapter: chain,
        listenHost: '127.0.0.1',
        dataDir,
        nodeRole: 'core',
        rfc64CatalogActivation: { enabled: false },
        swmHostMode: { enabled: true },
      });
      agent = core;
      // Production establishes the legacy-SWM boundary and the host-mode store
      // in start(); this test drives ingest without starting libp2p.
      const persistenceRoot = resolveRfc64PersistenceRootV1(dataDir);
      await mkdir(persistenceRoot, { mode: 0o700 });
      await initializeRfc64LegacySwmBoundaryV1(core, persistenceRoot, core.store);
      const limits = SwmHostModeStore.defaultLimits();
      const store = new SwmHostModeStore({
        dataDir: join(dataDir, 'swm-host'),
        unregisteredLimits: limits.unregistered,
        registeredLimits: limits.registered,
      });
      await store.init();
      const host = core as unknown as HostModeIngestInternals;
      host.swmHostModeStore = store;
      // A local signer, so the envelope is a real agent-signed gossip message.
      const signer = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'publisher');
      host.localAgents.set(signer.agentAddress, signer);
      host.defaultAgentAddress = signer.agentAddress;
      return core;
    }

    /**
     * A signed, plaintext SWM share: the self-signed open-publish path. The
     * signer is passed explicitly, so only the HOST's admission gate is under
     * test, never the sender-side signing authority.
     */
    async function signedPlaintextShare(
      host: HostModeIngestInternals,
      contextGraphId: string,
    ): Promise<Uint8Array> {
      const signer = host.localAgents.get(host.defaultAgentAddress ?? '');
      if (signer?.privateKey === undefined) throw new Error('host-mode fixture has no local signer');
      const agentAddress = signer.agentAddress.toLowerCase();
      return host.encodeWorkspaceGossipMessage(contextGraphId, encodeWorkspacePublishRequest({
        contextGraphId,
        nquads: new TextEncoder().encode(
          `<urn:finalized-publish:s> <http://schema.org/name> "Open" <did:dkg:context-graph:${contextGraphId}> .`,
        ),
        manifest: [],
        publisherPeerId: PUBLISHER_PEER,
        shareOperationId: `op-${contextGraphId}`,
        timestampMs: 1_700_000_000_000,
        agentAddress,
        kaNumber: '1',
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: `did:dkg:otp:20430/${agentAddress}/1`,
        assertionVersion: '1',
        publicTripleCount: 1,
        privateTripleCount: 0,
        accessPolicy: 'public',
        allowedPeers: [],
      }), { ...signer, privateKey: signer.privateKey });
    }

    async function hostedEntries(host: HostModeIngestInternals, contextGraphId: string) {
      return (await host.getSwmHostModeStats())?.perCg?.[contextGraphId]?.entries ?? 0;
    }

    it('drops a write for a graph switched to curated publish while the projection is stale-cache', async () => {
      const chain = new MockChainAdapter();
      const core = await createHostModeCore(chain);
      const host = core as unknown as HostModeIngestInternals;
      const nowCurated = 'finalized-host-ingest-now-curated';
      const stillOpen = 'finalized-host-ingest-still-open';
      const createPublicOpenGraph = async (contextGraphId: string): Promise<bigint> => {
        const { contextGraphId: onChainId } = await chain.createOnChainContextGraph({
          accessPolicy: 0,
          publishPolicy: 1,
          nameHash: core.contextGraphNameCommitment(contextGraphId),
        });
        bindOnChainId(core, contextGraphId, onChainId);
        return onChainId;
      };
      const curatedId = await createPublicOpenGraph(nowCurated);
      const openId = await createPublicOpenGraph(stillOpen);
      // The reader retained a projection while both graphs were open.
      const retained = [
        await chain.getContextGraphAuthoritySnapshot(curatedId),
        await chain.getContextGraphAuthoritySnapshot(openId),
      ];
      // The owner then switches one graph to curated publish
      // (`PublishPolicyUpdated`), and the reader's refresh fails, so it keeps
      // serving the retained projection as `stale-cache`.
      await chain.__updateContextGraphPublishPolicy(curatedId, 0);
      installFinalizedAuthorityReader(chain, retained, STALE_CACHE);
      const publishRpc = vi.spyOn(chain, 'getContextGraphPublishPolicy');

      await host.ingestSwmHostModeEnvelope(
        nowCurated,
        await signedPlaintextShare(host, nowCurated),
        PUBLISHER_PEER,
      );
      expect(await hostedEntries(host, nowCurated)).toBe(0);
      expect(publishRpc).toHaveBeenCalledWith(curatedId);

      // Control: the same stale projection for a graph that is still open on
      // chain is admitted, so the drop above is the publish bit alone.
      await host.ingestSwmHostModeEnvelope(
        stillOpen,
        await signedPlaintextShare(host, stillOpen),
        PUBLISHER_PEER,
      );
      expect(await hostedEntries(host, stillOpen)).toBe(1);
      expect(publishRpc).toHaveBeenCalledWith(openId);
    });
  });
});
