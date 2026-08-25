// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { multiaddr } from '@multiformats/multiaddr';
import {
  assertSafeIri,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  createOperationContext,
  DKG_ONTOLOGY,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  tryUpdateWithTouchedGraphs,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  META_REFRESH_COOLDOWN_MS,
  SYNC_TOTAL_TIMEOUT_MS,
} from './dkg-agent-constants.js';
import {
  hasAuthoritativePrivateMetaDefinition,
  type AuthoritativePrivateMetaMemberProof,
} from './context-graph-private-meta-proof.js';
import { hasAuthoritativePublicMetaDefinition } from './context-graph-public-meta-proof.js';
import { getSyncCheckpointKey, type SyncCheckpointStore } from './sync/checkpoint/state.js';
import {
  hasSyncAdmissionSource,
} from './sync/attempt-telemetry.js';
import { insertWithOversizeGuard, type OversizeDrop } from './sync/oversize-filter.js';
import type {
  SyncPageFetchOptions,
  SyncPageResult,
} from './sync/requester/page-fetch.js';
import type { SyncPhase } from './sync/auth/request-build.js';
import { stripLiteral } from './dkg-agent-utils.js';

export interface CuratorMetaRefreshOptions {
  signal?: AbortSignal;
  /**
   * A curator peer whose authority was already established by the caller.
   * The join-approved path uses the authenticated notification sender so
   * metadata recovery does not depend on metadata that has not arrived yet.
   */
  trustedCuratorPeerId?: string;
  /** Bypass the normal auth-probe cooldown for an explicit recovery event. */
  force?: boolean;
  /** Require the fetched snapshot to make this approved local member usable. */
  memberProof?: AuthoritativePrivateMetaMemberProof;
}

interface CuratorConnection {
  remotePeer: { toString(): string };
}

interface CuratorBoundSubscription {
  onChainId?: string;
  onChainHash?: string;
}

interface CuratorMetaRefreshAgent {
  readonly peerId: string;
  readonly metaRefreshTimestamps: Map<string, number>;
  readonly node: {
    libp2p: {
      getConnections(): CuratorConnection[];
      dial(target: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
      peerStore: {
        merge(target: unknown, data: { multiaddrs: unknown[] }): Promise<unknown>;
      };
    };
  };
  readonly discovery: {
    findAgentByPeerId(peerId: string): Promise<{ relayAddress?: string } | undefined>;
  };
  readonly store: TripleStore;
  readonly syncCheckpoints: Pick<SyncCheckpointStore, 'delete'>;
  readonly oversizeTombstoneLog: {
    record(drops: OversizeDrop[], seam: string): void;
  };
  readonly contextGraphMetaProjection: {
    markDirty(contextGraphId: string): void;
  };
  readonly subscribedContextGraphs?: Map<string, CuratorBoundSubscription>;
  readonly log: {
    warn(ctx: OperationContext, message: string): void;
    info(ctx: OperationContext, message: string): void;
  };
  invalidateListContextGraphsCache(): void;
  resolveCuratorPeerId(
    contextGraphId: string,
    options: CuratorMetaRefreshOptions,
  ): Promise<string | undefined>;
  fetchSyncPages(
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: SyncPhase,
    graphUri: string,
    deadline: number,
    options?: SyncPageFetchOptions,
  ): Promise<SyncPageResult>;
  runContextGraphSyncWithBackpressure<T>(
    ctx: OperationContext,
    contextGraphId: string,
    lane: 'durable',
    label: string,
    work: () => Promise<T>,
    admission: {
      operationSignal?: AbortSignal;
      source: 'control-plane';
    },
  ): Promise<T>;
  bindSubscriptionOnChainId?(
    localCgId: string,
    sub: CuratorBoundSubscription,
    newOnChainId: string,
  ): void;
  recordCgWireId?(localCgId: string, wireId: string | null): void;
  persistContextGraphSubscription?(contextGraphId: string): void;
}

interface CuratorMetaRefreshState {
  active: Promise<boolean>;
  /** Source of the newest scheduled replacement in `active`. */
  activeSource: string;
  /** Exactly one fresh run queued behind `active`; forced followers share it. */
  queued?: Promise<boolean>;
  queuedSource?: string;
}

interface AuthoritativeMetaSnapshot {
  checkpointKey: string;
  quads: Quad[];
}

/**
 * Apply the chain slot and wire-id carried by an authenticated curator
 * snapshot to the late member's durable subscription row.
 *
 * These facts deliberately come from the already-validated private `_meta`
 * snapshot.  Reading only the system ontology graph is insufficient for a
 * late member: the registration announcement on that public topic is a
 * one-shot event and may have happened before the member joined.
 */
function applyCuratorRegistrationBinding(
  agent: CuratorMetaRefreshAgent,
  contextGraphId: string,
  snapshot: readonly Quad[],
): void {
  const sub = agent.subscribedContextGraphs?.get(contextGraphId);
  if (!sub) return;

  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const onChainIdPredicate = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`;
  const onChainHashPredicate = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`;
  let onChainId: string | undefined;
  let onChainHash: string | undefined;

  for (const quad of snapshot) {
    if (quad.graph !== metaGraph || quad.subject !== contextGraphUri) continue;
    const value = stripLiteral(quad.object);
    if (quad.predicate === onChainIdPredicate && /^\d+$/.test(value)) {
      try {
        if (BigInt(value) > 0n) onChainId = value;
      } catch {
        // Ignore malformed or out-of-domain curator metadata fail-closed.
      }
    } else if (
      quad.predicate === onChainHashPredicate
      && /^0x[0-9a-fA-F]{64}$/.test(value)
    ) {
      onChainHash = value.toLowerCase();
    }
  }

  let changed = false;
  if (onChainId && sub.onChainId !== onChainId) {
    if (agent.bindSubscriptionOnChainId) {
      agent.bindSubscriptionOnChainId(contextGraphId, sub, onChainId);
    } else {
      sub.onChainId = onChainId;
    }
    changed = true;
  }
  if (onChainHash && sub.onChainHash?.toLowerCase() !== onChainHash) {
    if (agent.recordCgWireId) {
      agent.recordCgWireId(contextGraphId, onChainHash);
    } else {
      sub.onChainHash = onChainHash;
    }
    changed = true;
  }
  if (changed) agent.persistContextGraphSubscription?.(contextGraphId);
}

const inFlightCuratorMetaRefreshesByAgent = new WeakMap<
  CuratorMetaRefreshAgent,
  Map<string, CuratorMetaRefreshState>
>();

function inFlightCuratorMetaRefreshesFor(
  agent: CuratorMetaRefreshAgent,
): Map<string, CuratorMetaRefreshState> {
  let refreshes = inFlightCuratorMetaRefreshesByAgent.get(agent);
  if (!refreshes) {
    refreshes = new Map();
    inFlightCuratorMetaRefreshesByAgent.set(agent, refreshes);
  }
  return refreshes;
}

function curatorMetaRefreshAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    if (reason.name === 'AbortError') return reason;
    const err = new Error(reason.message || 'aborted');
    err.name = 'AbortError';
    (err as Error & { cause?: unknown }).cause = reason;
    return err;
  }
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfCuratorMetaRefreshAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw curatorMetaRefreshAbortError(signal.reason);
}

function waitForSharedRefresh(
  work: Promise<boolean>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(curatorMetaRefreshAbortError(signal.reason));
  return new Promise<boolean>((resolve, reject) => {
    const onAbort = () => reject(curatorMetaRefreshAbortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function ensureCuratorConnected(
  agent: CuratorMetaRefreshAgent,
  curatorPeerId: string,
  signal: AbortSignal | undefined,
  ctx: OperationContext,
): boolean | Promise<boolean> {
  const connections = agent.node.libp2p.getConnections();
  const isConnected = connections.some((connection) => (
    connection.remotePeer.toString() === curatorPeerId
  ));
  if (isConnected) return true;

  return dialCurator(agent, curatorPeerId, signal, ctx);
}

async function dialCurator(
  agent: CuratorMetaRefreshAgent,
  curatorPeerId: string,
  signal: AbortSignal | undefined,
  ctx: OperationContext,
): Promise<boolean> {
  let connections: CuratorConnection[] = [];
  let isConnected = false;

  try {
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const peerId = peerIdFromString(curatorPeerId);
    try {
      await agent.node.libp2p.dial(peerId, { signal });
      throwIfCuratorMetaRefreshAborted(signal);
      connections = agent.node.libp2p.getConnections();
      isConnected = connections.some((connection) => (
        connection.remotePeer.toString() === curatorPeerId
      ));
    } catch {
      // A regular dial may not have a usable direct address; relay is next.
    }

    if (!isConnected) {
      throwIfCuratorMetaRefreshAborted(signal);
      const discoveredAgent = await agent.discovery.findAgentByPeerId(curatorPeerId);
      throwIfCuratorMetaRefreshAborted(signal);
      if (discoveredAgent?.relayAddress) {
        const circuitAddress = multiaddr(
          `${discoveredAgent.relayAddress}/p2p-circuit/p2p/${curatorPeerId}`,
        );
        await agent.node.libp2p.peerStore.merge(peerId, { multiaddrs: [circuitAddress] });
        await agent.node.libp2p.dial(peerId, { signal });
        throwIfCuratorMetaRefreshAborted(signal);
        connections = agent.node.libp2p.getConnections();
        isConnected = connections.some((connection) => (
          connection.remotePeer.toString() === curatorPeerId
        ));
      }
    }
  } catch (error) {
    throwIfCuratorMetaRefreshAborted(signal);
    agent.log.warn(
      ctx,
      `Failed to dial curator ${curatorPeerId.slice(-8)} for meta refresh: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return isConnected;
}

async function fetchAuthoritativeMetaSnapshot(
  agent: CuratorMetaRefreshAgent,
  contextGraphId: string,
  curatorPeerId: string,
  options: CuratorMetaRefreshOptions,
  ctx: OperationContext,
): Promise<AuthoritativeMetaSnapshot | undefined> {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  // Clearing the offset alone is insufficient: page-fetch also retains
  // unfinished responder-session tokens. A guaranteed-new session prevents a
  // stale cached row list from being replayed as the authoritative snapshot.
  const snapshotCheckpointKey = getSyncCheckpointKey(
    curatorPeerId,
    contextGraphId,
    false,
    'meta',
  );
  agent.syncCheckpoints.delete(snapshotCheckpointKey);
  // W1 §5.5 — TRIGGER attribution with a base case.
  //
  // This is the only fetch in this file, and every route into it funnels here,
  // so one guard covers all three enumerated callers:
  //   1. `runImmediatePostApprovalSync` (dkg-agent-lifecycle.ts) — requester,
  //      no enclosing operation (gossipsub handler)
  //   2. `resolveCuratorPeerIdsForCg` (dkg-agent-lifecycle.ts) — requester,
  //      reached from the changelog lane's `runResync`, so it DOES run inside
  //      an admitted operation
  //   3. `authorizeSyncRequest` (sync/auth/request-authorize.ts) — RESPONDER,
  //      authorizing an inbound request; no requester operation exists
  //
  // `control-plane` therefore covers BOTH requester-side and responder-side
  // control traffic. Anyone later reading it as "requester meta refresh" is
  // wrong. A FOURTH caller must be checked against this list rather than
  // assumed to fit — the guard will silently give it a plausible label.
  //
  // Guarded on scope PRESENCE, never on `=== 'unspecified'`: an admitted
  // operation whose caller omitted `source` legitimately holds that sentinel,
  // and relabelling it `control-plane` would launder "we do not know" into a
  // confident answer. See `hasSyncAdmissionSource`'s doc comment.
  //
  // Case 2 keeps its ENCLOSING source on purpose. A refresh nested inside a
  // catch-up happens *because* of that catch-up — skip the catch-up and the
  // refresh does not happen — so those bytes are that lane's cost. Attributing
  // them to `control-plane` would move them out of the eligible numerator and
  // under-count the very lane §7.3 is evaluating.
  const runFetch = () => agent.fetchSyncPages(
    ctx,
    curatorPeerId,
    contextGraphId,
    false,
    'meta',
    metaGraph,
    // A curator projection shares the root `_meta` graph with KA lifecycle
    // metadata, so even the small control-plane subset can sit behind many
    // pages. Use the normal bounded sync budget instead of a special 10-second
    // cap that made sufficiently populated private CGs impossible to join.
    Date.now() + SYNC_TOTAL_TIMEOUT_MS,
    {
      signal: options.signal,
      forceFreshSession: true,
    },
  );
  // A standalone control-plane refresh is real outbound sync work. Admit it
  // through the node-wide scheduler so partitioned mode can route it to fast
  // capacity and the global cap still bounds it. Nested refreshes deliberately
  // stay inside their enclosing admission: acquiring twice could deadlock a
  // saturated partition, and the enclosing trigger remains the honest source.
  const result = await (hasSyncAdmissionSource()
    ? runFetch()
    : agent.runContextGraphSyncWithBackpressure(
      ctx,
      contextGraphId,
      'durable',
      'durable:control-plane',
      runFetch,
      {
        operationSignal: options.signal,
        source: 'control-plane',
      },
    ));
  throwIfCuratorMetaRefreshAborted(options.signal);

  // The shared N-Quads parser admits any graph under the CG prefix. This
  // trusted-control path retains only the exact requested root `_meta` graph.
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const delegationPrefix = `did:dkg:agent-delegation:${contextGraphId}:`;
  const controlMetaQuads = result.quads.filter((quad) => (
    quad.graph === metaGraph &&
    (quad.subject === contextGraphUri || quad.subject.startsWith(delegationPrefix))
  ));
  if (!result.completed || result.resumedFromOffset !== 0) {
    agent.syncCheckpoints.delete(snapshotCheckpointKey);
    agent.syncCheckpoints.delete(result.checkpointKey);
    return undefined;
  }
  const hasAuthoritativePublicDefinition = hasAuthoritativePublicMetaDefinition(
    contextGraphId,
    controlMetaQuads,
  );
  // Supplying memberProof selects the fail-closed private post-approval
  // contract. A public-only snapshot must not satisfy that request: public
  // subscriptions reach this refresh without a member proof.
  const acceptsAuthoritativePublicDefinition = options.memberProof === undefined
    && hasAuthoritativePublicDefinition;
  const hasAuthoritativePrivateDefinition = hasAuthoritativePrivateMetaDefinition(
    contextGraphId,
    controlMetaQuads,
    options.memberProof,
  );
  if (!acceptsAuthoritativePublicDefinition && !hasAuthoritativePrivateDefinition) {
    agent.syncCheckpoints.delete(snapshotCheckpointKey);
    agent.syncCheckpoints.delete(result.checkpointKey);
    agent.log.warn(
      ctx,
      `Rejected curator metadata snapshot for "${contextGraphId}": missing an unambiguous public definition or the complete private definition and approved-member delegation proof`,
    );
    return undefined;
  }
  return { checkpointKey: result.checkpointKey, quads: controlMetaQuads };
}

/**
 * Replace only the curator-replicated portion of a CG's root `_meta` graph.
 * `dkg:revokedAgent` is deliberately retained as a node-local tombstone.
 */
function replaceCuratorMetaProjectionSparql(
  contextGraphId: string,
  metaGraph: string,
  stagingGraph: string,
): string {
  const contextGraphUri = assertSafeIri(contextGraphDataGraphUri(contextGraphId));
  const delegationPrefix = `did:dkg:agent-delegation:${contextGraphId}:`;
  assertSafeIri(metaGraph);
  assertSafeIri(stagingGraph);
  return `DELETE {
    GRAPH <${metaGraph}> { ?staleSubject ?stalePredicate ?staleObject . }
  }
  INSERT {
    GRAPH <${metaGraph}> { ?freshSubject ?freshPredicate ?freshObject . }
  }
  WHERE {
    {
      GRAPH <${metaGraph}> {
        ?staleSubject ?stalePredicate ?staleObject .
        FILTER (
          (
            ?staleSubject = <${contextGraphUri}> &&
            ?stalePredicate != <${DKG_ONTOLOGY.DKG_REVOKED_AGENT}>
          ) ||
          STRSTARTS(STR(?staleSubject), ${JSON.stringify(delegationPrefix)})
        )
      }
    }
    UNION
    {
      GRAPH <${stagingGraph}> { ?freshSubject ?freshPredicate ?freshObject . }
    }
  }`;
}

async function atomicallyReplaceCuratorMetaSnapshot(
  agent: CuratorMetaRefreshAgent,
  contextGraphId: string,
  snapshot: readonly Quad[],
  ctx: OperationContext,
): Promise<void> {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const stagingGraph = `urn:dkg:curator-meta-refresh:${randomUUID()}`;
  try {
    const staged = await insertWithOversizeGuard(
      (kept) => agent.store.insert(
        kept.map((quad) => ({ ...quad, graph: stagingGraph })),
        { source: 'agent.metaRefresh.stage' },
      ),
      snapshot,
      { recordDrops: (drops, seam) => agent.oversizeTombstoneLog.record(drops, seam) },
      'curator-meta-refresh',
    );
    if (staged.length !== snapshot.length) {
      throw new Error(
        `Refusing partial curator metadata replacement: staged ${staged.length}/${snapshot.length} triples`,
      );
    }

    // A decorated store can commit its inner UPDATE and then throw while
    // appending a changelog marker. Invalidate before and after the attempt so
    // no authorization read can retain the previous ACL across that window.
    const invalidateTargetProjections = () => {
      agent.contextGraphMetaProjection.markDirty(contextGraphId);
      agent.invalidateListContextGraphsCache();
    };
    invalidateTargetProjections();
    let replaced = false;
    try {
      replaced = await tryUpdateWithTouchedGraphs(
        agent.store,
        replaceCuratorMetaProjectionSparql(contextGraphId, metaGraph, stagingGraph),
        [metaGraph],
        { source: 'agent.metaRefresh.replace' },
      );
    } finally {
      invalidateTargetProjections();
    }
    if (!replaced) {
      throw new Error('Triple store does not support atomic curator metadata replacement');
    }
  } finally {
    try {
      await agent.store.dropGraph(stagingGraph, { source: 'agent.metaRefresh.cleanup' });
    } catch (cleanupError) {
      agent.log.warn(
        ctx,
        `Failed to clean curator metadata staging graph: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
  }
}

async function executeCuratorMetaRefresh(
  agent: CuratorMetaRefreshAgent,
  contextGraphId: string,
  curatorPeerId: string,
  options: CuratorMetaRefreshOptions,
  ctx: OperationContext,
): Promise<boolean> {
  const connectionResult = ensureCuratorConnected(
    agent,
    curatorPeerId,
    options.signal,
    ctx,
  );
  const connected = typeof connectionResult === 'boolean'
    ? connectionResult
    : await connectionResult;
  if (!connected) {
    return false;
  }

  try {
    const snapshot = await fetchAuthoritativeMetaSnapshot(
      agent,
      contextGraphId,
      curatorPeerId,
      options,
      ctx,
    );
    if (!snapshot) return false;
    await atomicallyReplaceCuratorMetaSnapshot(agent, contextGraphId, snapshot.quads, ctx);
    applyCuratorRegistrationBinding(agent, contextGraphId, snapshot.quads);
    agent.syncCheckpoints.delete(snapshot.checkpointKey);
    agent.log.info(
      ctx,
      `Meta refresh for "${contextGraphId}": replaced curator projection with ${snapshot.quads.length} triples from ${curatorPeerId.slice(-8)}`,
    );
    return true;
  } catch (error) {
    throwIfCuratorMetaRefreshAborted(options.signal);
    agent.log.warn(
      ctx,
      `Meta refresh for "${contextGraphId}" failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  } finally {
    agent.metaRefreshTimestamps.set(contextGraphId, Date.now());
  }
}

function scheduleCuratorMetaRefresh(
  agent: CuratorMetaRefreshAgent,
  contextGraphId: string,
  curatorPeerId: string,
  options: CuratorMetaRefreshOptions,
  ctx: OperationContext,
): Promise<boolean> {
  const refreshes = inFlightCuratorMetaRefreshesFor(agent);
  const existingState = refreshes.get(contextGraphId);
  const execute = (runOptions: CuratorMetaRefreshOptions) => executeCuratorMetaRefresh(
    agent,
    contextGraphId,
    curatorPeerId,
    runOptions,
    ctx,
  );

  if (existingState) {
    // Explicit post-approval/credential events queue one fresh generation;
    // concurrent followers share it. Different curator sources also serialize
    // by target graph so two snapshot replacements can never race.
    if (!options.force && existingState.activeSource === curatorPeerId) {
      return waitForSharedRefresh(existingState.active, options.signal);
    }
    if (
      options.force
      && existingState.queued
      && existingState.queuedSource === curatorPeerId
    ) {
      return waitForSharedRefresh(existingState.queued, options.signal);
    }

    const predecessor = existingState.active;
    let queued!: Promise<boolean>;
    const startFreshGeneration = () => {
      if (existingState.queued === queued) {
        existingState.queued = undefined;
        existingState.queuedSource = undefined;
      }
      // Shared mutation-triggered work outlives any individual waiting caller.
      return execute({ ...options, signal: undefined, force: true });
    };
    queued = predecessor.then(startFreshGeneration, startFreshGeneration);
    existingState.active = queued;
    existingState.activeSource = curatorPeerId;
    existingState.queued = queued;
    existingState.queuedSource = curatorPeerId;
    const cleanup = () => {
      if (
        refreshes.get(contextGraphId) === existingState
        && existingState.active === queued
        && !existingState.queued
      ) {
        refreshes.delete(contextGraphId);
      }
    };
    queued.then(cleanup, cleanup);
    return waitForSharedRefresh(queued, options.signal);
  }

  const refresh = execute(options);
  const state: CuratorMetaRefreshState = {
    active: refresh,
    activeSource: curatorPeerId,
  };
  refreshes.set(contextGraphId, state);
  return refresh.finally(() => {
    if (
      refreshes.get(contextGraphId) === state
      && state.active === refresh
      && !state.queued
    ) {
      refreshes.delete(contextGraphId);
    }
  });
}

/**
 * Resolve, serialize, fetch, validate, and atomically install a curator's
 * authoritative root metadata snapshot.
 */
export async function runCuratorMetaRefresh(
  agent: object,
  contextGraphId: string,
  options: CuratorMetaRefreshOptions = {},
): Promise<boolean> {
  const refreshAgent = agent as CuratorMetaRefreshAgent;
  throwIfCuratorMetaRefreshAborted(options.signal);
  const lastRefresh = refreshAgent.metaRefreshTimestamps.get(contextGraphId) ?? 0;
  if (!options.force && Date.now() - lastRefresh < META_REFRESH_COOLDOWN_MS) {
    return false;
  }

  const ctx = createOperationContext('sync');
  const curatorPeerId = options.trustedCuratorPeerId
    ?? await refreshAgent.resolveCuratorPeerId(contextGraphId, options);
  throwIfCuratorMetaRefreshAborted(options.signal);
  if (!curatorPeerId || curatorPeerId === refreshAgent.peerId) return false;
  return scheduleCuratorMetaRefresh(
    refreshAgent,
    contextGraphId,
    curatorPeerId,
    options,
    ctx,
  );
}
