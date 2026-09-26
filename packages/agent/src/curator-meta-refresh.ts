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
  tryReplaceSubjectAtomically,
  tryUpdateWithTouchedGraphs,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  META_REFRESH_COOLDOWN_MS,
  SYNC_TOTAL_TIMEOUT_MS,
} from './dkg-agent-constants.js';
import {
  hasActiveApprovedMemberDelegation,
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
import { isCanonicalAuthoritativeContextGraphId } from
  './context-graph-binding-state.js';

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
  /**
   * Accept only an unambiguous PUBLIC root definition. Set by the RFC-64
   * replica metadata bootstrap, whose accepted owner-signed policy is already
   * known to be public: a peer-served private definition must then be
   * rejected instead of installed, so an arbitrary connected peer cannot flip
   * the local graph private. Mutually exclusive with `memberProof`.
   */
  requirePublicDefinition?: boolean;
  /**
   * The serving peer is an UNAUTHENTICATED relay of the declaration (RFC-64
   * replica bootstrap from whichever peers happen to be connected), not a
   * curator whose authority the caller established. The snapshot's chain
   * registration claims -- `OnChainId`, `OnChainHash`, and any
   * `registrationStatus` other than the `unregistered` placeholder -- are
   * stripped BEFORE the projection is installed, and no subscription chain
   * binding is applied afterwards. A chain binding may only come from chain
   * truth (finalized authority index / name-hash resolution). The
   * authenticated join-approval and curator-resolved refreshes never set this.
   */
  ignoreRegistrationBinding?: boolean;
  /**
   * Reject a snapshot whose root `dkg:curator` names any wallet other than
   * this EVM address (case-insensitive). Set by the RFC-64 replica bootstrap
   * to the owner the accepted policy already authenticated, so a relayed
   * declaration cannot re-home the graph under a stranger's identity. A
   * snapshot that names no curator passes this check.
   */
  expectedCuratorAddress?: string;
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
    options: { signal?: AbortSignal },
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
  /** Access policy of this node's accepted, authenticated RFC-64 authority. */
  readAcceptedRfc64CatalogAccessPolicyV1?(contextGraphId: string): 'public' | 'private' | null;
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

const CURATOR_AGENT_DID_PREFIX = 'did:dkg:agent:';

/**
 * Registration claims a relayed (unauthenticated-source) snapshot may not
 * carry into the local projection. `OnChainId` / `OnChainHash` are the chain
 * binding `applyCuratorRegistrationBinding` and the cgId resolver read;
 * `registrationStatus` is the local registration state machine's fence. Only
 * the `unregistered` placeholder survives: it is what the author writes for an
 * unregistered graph and it can only make metadata confirmation stricter.
 */
function isRelayedRegistrationClaim(predicate: string, object: string): boolean {
  if (
    predicate === `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`
    || predicate === `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`
  ) return true;
  return predicate === DKG_ONTOLOGY.DKG_REGISTRATION_STATUS
    && stripLiteral(object).trim().toLowerCase() !== 'unregistered';
}

/** Drop every root-subject chain-registration claim from a relayed snapshot. */
export function stripRelayedRegistrationBindingQuads(
  contextGraphId: string,
  snapshot: readonly Quad[],
): Quad[] {
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  return snapshot.filter((quad) => !(
    quad.graph === metaGraph
    && quad.subject === contextGraphUri
    && isRelayedRegistrationClaim(quad.predicate, quad.object)
  ));
}

/**
 * Whether every root `dkg:curator` row of the snapshot names `expectedAddress`.
 * A curator DID is `did:dkg:agent:<evm address>`; anything else (another
 * wallet, a peer id, a malformed value) is a mismatch. No curator row passes.
 */
export function snapshotCuratorMatches(
  contextGraphId: string,
  snapshot: readonly Quad[],
  expectedAddress: string,
): boolean {
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const expected = `${CURATOR_AGENT_DID_PREFIX}${expectedAddress.toLowerCase()}`;
  return snapshot.every((quad) => (
    quad.graph !== metaGraph
    || quad.subject !== contextGraphUri
    || quad.predicate !== DKG_ONTOLOGY.DKG_CURATOR
    || stripLiteral(quad.object).trim().toLowerCase() === expected
  ));
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
  let invalidOnChainId = false;

  for (const quad of snapshot) {
    if (quad.graph !== metaGraph || quad.subject !== contextGraphUri) continue;
    const value = stripLiteral(quad.object);
    if (quad.predicate === onChainIdPredicate) {
      if (isCanonicalAuthoritativeContextGraphId(value)) {
        onChainId = value;
      } else {
        invalidOnChainId = true;
      }
    } else if (
      quad.predicate === onChainHashPredicate
      && /^0x[0-9a-fA-F]{64}$/.test(value)
    ) {
      onChainHash = value.toLowerCase();
    }
  }

  // Treat the numeric slot and commitment as one registration claim. A
  // malformed or out-of-uint256 slot must not leave behind a hash-only durable
  // binding or turn untrusted metadata into a strict-writer exception.
  if (invalidOnChainId) return;

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
  // Supplying memberProof selects the fail-closed post-approval contract.
  // Public subscriptions reach this refresh without a member proof. A join can
  // also be approved on a PUBLIC graph, whose allowlist governs publishing
  // rather than reads; its public snapshot satisfies the post-approval
  // contract only when this node's accepted, authenticated policy already says
  // public and the snapshot proves the approved member exactly as a private
  // one must (#2827). An accepted private or unknown policy keeps rejecting it,
  // so a peer cannot downgrade a private graph by serving a public definition.
  const acceptsAuthoritativePublicDefinition = hasAuthoritativePublicDefinition && (
    options.memberProof === undefined
    || (
      agent.readAcceptedRfc64CatalogAccessPolicyV1?.(contextGraphId) === 'public'
      && hasActiveApprovedMemberDelegation(contextGraphId, controlMetaQuads, options.memberProof)
    )
  );
  // A public-only bootstrap never installs a private definition, however
  // complete: the caller's accepted policy already says the graph is public.
  const hasAuthoritativePrivateDefinition = options.requirePublicDefinition !== true
    && hasAuthoritativePrivateMetaDefinition(
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
  if (
    options.expectedCuratorAddress !== undefined
    && !snapshotCuratorMatches(contextGraphId, controlMetaQuads, options.expectedCuratorAddress)
  ) {
    agent.syncCheckpoints.delete(snapshotCheckpointKey);
    agent.syncCheckpoints.delete(result.checkpointKey);
    agent.log.warn(
      ctx,
      `Rejected curator metadata snapshot for "${contextGraphId}" from ${curatorPeerId.slice(-8)}: `
      + 'its curator is not the owner the accepted policy names',
    );
    return undefined;
  }
  // A relayed declaration is installed without its chain-registration claims;
  // the peer that served it is not a source of chain truth.
  const quads = options.ignoreRegistrationBinding === true
    ? stripRelayedRegistrationBindingQuads(contextGraphId, controlMetaQuads)
    : controlMetaQuads;
  return { checkpointKey: result.checkpointKey, quads };
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
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const delegationPrefix = `did:dkg:agent-delegation:${contextGraphId}:`;
  const invalidateTargetProjections = () => {
    agent.contextGraphMetaProjection.markDirty(contextGraphId);
    agent.invalidateListContextGraphsCache();
  };

  // A remote endpoint can safely replace one subject in a shared graph without
  // staging a second graph. Prefer that primitive here. Besides avoiding the
  // whole-projection staging race under concurrent VM materialization, the
  // ordering is fail closed: new delegation proofs land before the root ACL,
  // the root subject is the activation boundary, and stale delegations are
  // removed only after their allowedAgent row is gone.
  if (typeof agent.store.replaceSubject === 'function') {
    const [localRevocations, existingDelegationSubjects] = await Promise.all([
      agent.store.query(`
        SELECT ?o WHERE {
          GRAPH <${assertSafeIri(metaGraph)}> {
            <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.DKG_REVOKED_AGENT}> ?o .
          }
        }
      `, { source: 'agent.metaRefresh.readLocalRevocations' }),
      agent.store.query(`
        SELECT DISTINCT ?s WHERE {
          GRAPH <${assertSafeIri(metaGraph)}> {
            ?s (
              <${DKG_ONTOLOGY.DKG_DELEGATION_AGENT}> |
              <${DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT}> |
              <${DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT}> |
              <${DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER}> |
              <${DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY}>
            ) ?delegationValue .
          }
          FILTER(STRSTARTS(STR(?s), ${JSON.stringify(delegationPrefix)}))
        }
      `, { source: 'agent.metaRefresh.readLocalDelegations' }),
    ]);
    if (
      localRevocations.type !== 'bindings'
      || existingDelegationSubjects.type !== 'bindings'
    ) {
      throw new Error('Curator metadata replacement requires control-plane bindings');
    }

    const desiredBySubject = new Map<string, Quad[]>();
    for (const quad of snapshot) {
      const rows = desiredBySubject.get(quad.subject) ?? [];
      rows.push(quad);
      desiredBySubject.set(quad.subject, rows);
    }
    const rootRows = desiredBySubject.get(contextGraphUri) ?? [];
    const localRevocationRows: Quad[] = localRevocations.bindings
      .filter((row) => typeof row['o'] === 'string')
      .map((row) => ({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT,
        object: row['o']!,
        graph: metaGraph,
      }));
    const rootRowKeys = new Set(rootRows.map((quad) => `${quad.predicate}\u0000${quad.object}`));
    const rootReplacement = [
      ...rootRows,
      ...localRevocationRows.filter(
        (quad) => !rootRowKeys.has(`${quad.predicate}\u0000${quad.object}`),
      ),
    ];
    const desiredDelegations = [...desiredBySubject.entries()]
      .filter(([subject]) => subject.startsWith(delegationPrefix))
      .sort(([left], [right]) => left.localeCompare(right));
    const existingDelegations = new Set(
      existingDelegationSubjects.bindings
        .map((row) => row['s'])
        .filter((subject): subject is string => (
          typeof subject === 'string' && subject.startsWith(delegationPrefix)
        )),
    );

    invalidateTargetProjections();
    try {
      const replaceSubject = async (subject: string, quads: Quad[]): Promise<void> => {
        const replaced = await tryReplaceSubjectAtomically(
          agent.store,
          metaGraph,
          subject,
          quads,
          { source: 'agent.metaRefresh.replaceSubject' },
        );
        if (!replaced) {
          throw new Error('Triple store lost atomic subject-replacement capability');
        }
      };
      for (const [subject, quads] of desiredDelegations) {
        await replaceSubject(subject, quads);
        existingDelegations.delete(subject);
      }
      await replaceSubject(contextGraphUri, rootReplacement);
      for (const staleSubject of [...existingDelegations].sort()) {
        await replaceSubject(staleSubject, []);
      }
    } finally {
      invalidateTargetProjections();
    }
    return;
  }

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
    // The relayed snapshot carries no binding claims any more (stripped above);
    // skipping the binding step keeps the subscription row untouched even if a
    // future field slipped past the strip list. Chain bindings for such a
    // graph arrive only through the finalized-index / name-hash paths.
    if (options.ignoreRegistrationBinding !== true) {
      applyCuratorRegistrationBinding(agent, contextGraphId, snapshot.quads);
    }
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

/**
 * Generation identity for result sharing. A relayed (binding-stripped) run and
 * an authenticated curator run against the same peer are different contracts:
 * neither may be satisfied by the other's result, though both still serialize
 * on the target graph.
 */
function curatorMetaRefreshSourceKey(
  curatorPeerId: string,
  options: CuratorMetaRefreshOptions,
): string {
  return options.ignoreRegistrationBinding === true
    ? `${curatorPeerId}\u0000relayed`
    : curatorPeerId;
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
  const source = curatorMetaRefreshSourceKey(curatorPeerId, options);
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
    if (!options.force && existingState.activeSource === source) {
      return waitForSharedRefresh(existingState.active, options.signal);
    }
    if (
      options.force
      && existingState.queued
      && existingState.queuedSource === source
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
    existingState.activeSource = source;
    existingState.queued = queued;
    existingState.queuedSource = source;
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
    activeSource: source,
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

function curatorMetaRefreshCoolingDown(
  agent: CuratorMetaRefreshAgent,
  contextGraphId: string,
  force: boolean | undefined,
): boolean {
  const lastRefresh = agent.metaRefreshTimestamps.get(contextGraphId) ?? 0;
  return !force && Date.now() - lastRefresh < META_REFRESH_COOLDOWN_MS;
}

function runResolvedCuratorMetaRefresh(
  agent: CuratorMetaRefreshAgent,
  contextGraphId: string,
  curatorPeerId: string | undefined,
  options: CuratorMetaRefreshOptions,
): Promise<boolean> {
  throwIfCuratorMetaRefreshAborted(options.signal);
  if (!curatorPeerId || curatorPeerId === agent.peerId) return Promise.resolve(false);
  return scheduleCuratorMetaRefresh(
    agent,
    contextGraphId,
    curatorPeerId,
    options,
    createOperationContext('sync'),
  );
}

/** Refresh through one peer selected by a dedicated caller-owned coordinator. */
export function runCuratorMetaRefreshFromPeer(
  agent: object,
  contextGraphId: string,
  curatorPeerId: string | undefined,
  options: CuratorMetaRefreshOptions = {},
): Promise<boolean> {
  const refreshAgent = agent as CuratorMetaRefreshAgent;
  throwIfCuratorMetaRefreshAborted(options.signal);
  if (curatorMetaRefreshCoolingDown(refreshAgent, contextGraphId, options.force)) {
    return Promise.resolve(false);
  }
  return runResolvedCuratorMetaRefresh(
    refreshAgent,
    contextGraphId,
    curatorPeerId,
    options,
  );
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
  if (curatorMetaRefreshCoolingDown(refreshAgent, contextGraphId, options.force)) {
    return false;
  }

  const curatorPeerId = options.trustedCuratorPeerId
    ?? await refreshAgent.resolveCuratorPeerId(contextGraphId, { signal: options.signal });
  return runResolvedCuratorMetaRefresh(
    refreshAgent,
    contextGraphId,
    curatorPeerId,
    options,
  );
}
