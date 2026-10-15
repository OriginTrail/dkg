// Fixtures for the catch-up readiness tests: a member Edge whose agent double
// answers the subscribe route, the production readiness inspection and the
// agent side of the catch-up bridge, over eight sync-capable peers, and the
// rounds those peers can answer.
import { DKGAgent, emptySharedMemorySyncResult } from '@origintrail-official/dkg-agent';
import { createIncompleteDurableSyncResult } from '@origintrail-official/dkg-agent/dist/sync/durable-progress.js';
import { recordSharedMemoryPhaseFailure } from '@origintrail-official/dkg-agent/dist/sync/shared-memory-diagnostics.js';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import type { CatchupJobResult } from '../../src/catchup-runner.js';
import { catchupReadinessResult, sharedMemoryDiagnostics } from './catchup-readiness-fixtures.js';

export const CG = '0x1111111111111111111111111111111111111111/issue-3207-empty-public';
export const PEERS = ['peer-1', 'peer-2', 'peer-3', 'peer-4', 'peer-5', 'peer-6', 'peer-7', 'peer-8'];
/** The member Edge's default agent. */
export const DEFAULT_AGENT = '0x0000000000000000000000000000000000000001';

/** Admission of a public graph that is not registered on chain: its accepted owner policy. */
export const PUBLIC_UNREGISTERED = Object.freeze({
  outcome: 'allowed',
  source: 'rfc64-public',
  reason: 'accepted-public-policy',
  metadataBootstrap: 'eligible',
  grantScope: 'public',
  registration: 'unregistered',
} as const);

/** A peer's answer for a graph with nothing in it: both phases complete and empty. */
export function emptyAnswer(peerId: string) {
  return {
    kind: 'selected-shared-memory',
    shared: {
      ...emptySharedMemorySyncResult(),
      emptyResponses: 1,
      completedPhases: 2,
      swmCoverage: {
        contextGraphId: CG,
        peerIdSuffix: peerId,
        snapshotsResolved: 0,
        snapshotsTotal: 0,
        manifestComplete: true,
        descriptorsAuthoritative: true,
        missingCount: 0,
        missingSample: [],
        materializationFailures: 0,
      },
    },
    scopeComplete: false,
  };
}

/**
 * What the requester returns for a sync this node aborted itself. A receiver
 * selection change of the graph revokes the graph's recovery lease; every
 * sync holding it throws "RFC-64 SWM recovery authority was revoked", and the
 * requester records that error, which carries no transport tag, as a failed
 * phase of a peer that did answer.
 */
export function revokedAnswer() {
  const shared = emptySharedMemorySyncResult();
  recordSharedMemoryPhaseFailure(shared, 'materialization');
  return { kind: 'selected-shared-memory', shared, scopeComplete: false };
}

/** A round of eight peers: five answered empty, three were revoked mid-sync. */
export function lossyEmptyRound(): CatchupJobResult {
  return catchupReadinessResult({
    connectedPeers: 8, totalPeers: 8, selectedPeers: 8, syncCapablePeers: 8,
    peersTried: 8, peersResponded: 8, peersSucceeded: 5,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers: 0, verifiedPrivateOnlyPeers: 0, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 5, incompleteResponders: 3 },
    },
    diagnostics: {
      noProtocolPeers: 0,
      durable: catchupReadinessResult().diagnostics.durable,
      sharedMemory: sharedMemoryDiagnostics({ emptyResponses: 5, completedPhases: 10, failedPhases: 3 }),
    },
  });
}

/** The same graph a moment later: every peer answered empty. */
export function cleanEmptyRound(): CatchupJobResult {
  return catchupReadinessResult({
    connectedPeers: 8, totalPeers: 8, selectedPeers: 8, syncCapablePeers: 8,
    peersTried: 8, peersResponded: 8, peersSucceeded: 8,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers: 0, verifiedPrivateOnlyPeers: 0, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 8 },
    },
    diagnostics: {
      noProtocolPeers: 0,
      durable: catchupReadinessResult().diagnostics.durable,
      sharedMemory: sharedMemoryDiagnostics({ emptyResponses: 8, completedPhases: 16 }),
    },
  });
}

/** Every peer refused the graph: no clean answer outranks the denial. */
export function deniedRound(): CatchupJobResult {
  return catchupReadinessResult({
    connectedPeers: 8, totalPeers: 8, selectedPeers: 8, syncCapablePeers: 8,
    peersTried: 8, peersResponded: 8, denied: true, deniedPeers: 8,
    diagnostics: {
      noProtocolPeers: 0,
      durable: catchupReadinessResult().diagnostics.durable,
      sharedMemory: sharedMemoryDiagnostics({ deniedPhases: 8 }),
    },
  });
}

export type Authority = Record<string, unknown>;

/** Answers an admission read; it may depend on the agent asking. */
export type AuthorityAnswer = Authority | ((callerAgentAddress: string | undefined) => Authority);

/**
 * A member Edge: the subscription, the readiness store, the production
 * readiness inspection, and the agent side of the catch-up bridge over eight
 * sync-capable peers on the graph's selected public lane.
 */
export function memberEdge() {
  const subscriptions = new Map<string, Record<string, unknown>>();
  let readiness: Record<string, unknown> | undefined;
  const node = {
    authority: PUBLIC_UNREGISTERED as AuthorityAnswer,
    answer: (peerId: string): unknown => emptyAnswer(peerId),
    /** Whether the graph's definition is installed. */
    confirmedMeta: true,
    /** This node's local agents. */
    localAgents: [DEFAULT_AGENT],
    /** The local agent the graph names (its allowlist, a join); else the lookup gives the default agent. */
    namedAgent: undefined as string | undefined,
    /** The agent each admission read asked as, in order. */
    admissionCallers: [] as Array<string | undefined>,
    /** Name hashes the agent adopted, by their verified cleartext id. */
    aliases: new Map<string, string>(),
  };
  const agent = {
    resolveContextGraphSubscriptionBootstrapAuthority: async (
      _contextGraphId: string,
      options?: { callerAgentAddress?: string },
    ) => {
      node.admissionCallers.push(options?.callerAgentAddress);
      return typeof node.authority === 'function' ? node.authority(options?.callerAgentAddress) : node.authority;
    },
    findLocalAgentForContextGraph: async () => node.namedAgent ?? DEFAULT_AGENT,
    resolveContextGraphIdAlias: (contextGraphId: string) => node.aliases.get(contextGraphId) ?? null,
    listLocalAgents: () => node.localAgents.map((agentAddress) => ({ agentAddress })),
    subscribedContextGraphs: subscriptions,
    getSubscribedContextGraphs: () => subscriptions,
    subscribeToContextGraph: (id: string, options?: { syncMode?: string }) => {
      const previous = subscriptions.get(id);
      const applied = {
        ...previous,
        subscribed: true,
        synced: previous?.synced ?? false,
        syncMode: options?.syncMode ?? 'always-on',
      };
      subscriptions.set(id, applied);
      return applied;
    },
    markContextGraphSubscriptionState: (id: string, patch: Record<string, unknown>) => {
      subscriptions.set(id, { ...subscriptions.get(id), ...patch });
    },
    // The graph's definition is installed; the job's metadata pull is a no-op.
    bootstrapRfc64CatalogContextGraphMetadataFromPeersV1: async () => 'already-confirmed',
    hasConfirmedMetaState: async () => node.confirmedMeta,
    isPrivateContextGraph: async () => false,
    reconcileRfc64CatalogResponsibilityV1: async () => {},
    contextGraphMetaProjection: { readContextGraphAuthorityFactsRevision: () => '0' },
    inspectAndCommitContextGraphReadinessV1: DKGAgent.prototype.inspectAndCommitContextGraphReadinessV1,
    prepareContextGraphReadinessWithPrivateEmptyVmV1:
      DKGAgent.prototype.prepareContextGraphReadinessWithPrivateEmptyVmV1,
    config: { chainConfig: undefined },
    contextGraphAuthorityReaderCapability: { status: 'unsupported' },
    resolveAgentByToken: () => undefined,
    getDefaultAgentAddress: () => DEFAULT_AGENT,
    // The catch-up bridge. No curator is resolvable for the walk, as for an
    // unregistered graph whose owner is one Edge among the connected peers.
    resolveSyncPeerWithProvenance: async () => ({ peerId: undefined, provenance: 'bootstrap-hint' }),
    resolveRfc64CompleteSwmProviderPeerIdsV1: () => [],
    resolveRfc64SwmRecoveryRuntimeAuthorityV1: (contextGraphId: string) => ({
      kind: 'rfc64-swm-recovery-runtime-authority-v1',
      contextGraphId,
      lane: 'selected-public',
      active: true,
    }),
    resolveRfc64CatalogReceiverAuthorityV1: (contextGraphId: string) => ({
      contextGraphId,
      legacySyncAllowed: false,
    }),
    ensurePeerConnected: async () => {},
    primeCatchupConnections: async () => {},
    listAdmittedConnectedPeers: async () => PEERS.map((peerId) => ({ toString: () => peerId })),
    selectCatchupPeers: (peers: Array<{ toString(): string }>) => peers,
    waitForSyncProtocol: async () => true,
    syncDurableRecoveryContextGraph: async () => ({ result: createIncompleteDurableSyncResult() }),
    syncSelectedSharedMemoryFromPeerDetailed: async (peerId: string) => node.answer(peerId),
    syncSharedMemoryFromPeerDetailed: async () => {
      throw new Error('a catalog-authoritative graph has no ordinary shared-memory lane');
    },
    refreshMetaSyncedFlags: async () => {},
    log: { info: () => {}, debug: () => {}, warn: () => {} },
    eventBus: new TypedEventBus(),
    // The legacy readiness migration's reads for a row it may preserve.
    isCuratorOf: async () => false,
    getContextGraphOnChainPolicy: async () => ({}),
  };
  return {
    agent: agent as unknown as DKGAgent,
    node,
    subscription: () => subscriptions.get(CG),
    /** Install a row the way the agent's activation restores a persisted one. */
    restore: (row: Record<string, unknown>, contextGraphId: string = CG) => subscriptions.set(contextGraphId, row),
    unsubscribe: () => subscriptions.set(CG, { ...subscriptions.get(CG), subscribed: false }),
    /** Adopt a row saved under its name hash under its verified cleartext id, as name resolution does. */
    adopt: (nameHash: string, cleartextId: string) => {
      const row = subscriptions.get(nameHash);
      subscriptions.delete(nameHash);
      subscriptions.set(cleartextId, { ...row, subscribed: true, synced: false, sharedMemorySynced: false });
      node.aliases.set(nameHash, cleartextId);
    },
    readiness: () => readiness,
    store: {
      getContextGraphReadinessProvenance: () => readiness ?? null,
      setContextGraphReadinessProvenance: (_id: string, next: Record<string, unknown>) => {
        readiness = { ...next, updatedAt: Date.now() };
      },
    },
  };
}

export async function waitUntil<T>(probe: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 400; i += 1) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}
