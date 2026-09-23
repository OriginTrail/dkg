// SPDX-License-Identifier: Apache-2.0

/**
 * Cleartext recovery for Context Graphs this node knows only by their on-chain
 * name hash.
 *
 * The `ContextGraphCreated` event carries `nameHash = keccak256(utf8(id))`,
 * never the id itself. A node that learned a graph that way holds a hash-keyed
 * placeholder row, and a subscription to that row asks every peer for
 * `did:dkg:context-graph:<hash>/…`, which no holder has: holders key the data
 * by the cleartext id. This mixin finds the cleartext (see
 * `context-graph-name-resolver.ts`), verifies it against the hash, and promotes
 * the placeholder through the canonical wire-only adoption path, so exact VM
 * fetch, SWM sync, the RFC-64 catalog digest and curator lookup all use the
 * cleartext id afterwards.
 *
 * It also serves `/dkg/10.0.0/context-graph-name/1` for other nodes, revealing
 * only ids of graphs this node's own authority state proves public.
 */

import {
  DKG_ONTOLOGY,
  PROTOCOL_SYNC,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  createOperationContext,
  isProtocolUnsupportedError,
} from '@origintrail-official/dkg-core';

import { runBoundedOperation } from './bounded-operation.js';
import { chainAuthorityReadBudgetsOf } from './chain-authority-read-budgets.js';
import {
  CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE,
  CONTEXT_GRAPH_SUBJECT_PREFIX,
  contextGraphNameCommitmentOf,
  findContextGraphNameInOntologyQuads,
  normalizeContextGraphNameHash,
  verifyContextGraphNameCandidate,
} from './context-graph-name-candidate.js';
import {
  CONTEXT_GRAPH_NAME_MAX_REQUEST_BYTES,
  CONTEXT_GRAPH_NAME_MAX_RESPONSE_BYTES,
  PROTOCOL_CONTEXT_GRAPH_NAME,
  createContextGraphNameRequestHandler,
  decodeContextGraphNameResponse,
  encodeContextGraphNameRequest,
} from './context-graph-name-protocol.js';
import {
  ContextGraphNameResolver,
  type ContextGraphNamePolicy,
  type ContextGraphNameResolutionEntry,
  type ContextGraphNameSource,
  type ContextGraphNameTarget,
} from './context-graph-name-resolver.js';
import { projectContextGraphSubscriptionPersistence } from './context-graph-subscription-policy.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from './dkg-agent-types.js';
import type { DKGAgent } from './dkg-agent.js';
import { stripLiteral } from './dkg-agent-utils.js';
import { MemorySyncCheckpointStore } from './sync/checkpoint/state.js';

/** Per-request budget for one peer's answer. */
const CONTEXT_GRAPH_NAME_ASK_TIMEOUT_MS = 5_000;
/** One ontology pull: bounded in time, rows and heap, scanned in memory. */
const CONTEXT_GRAPH_NAME_ONTOLOGY_PULL_TIMEOUT_MS = 15_000;
const CONTEXT_GRAPH_NAME_ONTOLOGY_MAX_QUADS = 50_000;
const CONTEXT_GRAPH_NAME_ONTOLOGY_MAX_HEAP_BYTES = 32 * 1024 * 1024;
/** Local-store scan bounds. */
const CONTEXT_GRAPH_NAME_LOCAL_SCAN_TIMEOUT_MS = 5_000;
const CONTEXT_GRAPH_NAME_LOCAL_SCAN_MAX_ROWS = 10_000;
/** Reveal verdicts: proofs are kept (bounded); refusals only briefly. */
const MAX_REMEMBERED_REVEAL_VERDICTS = 4_096;
const REVEAL_REFUSAL_MEMO_MS = 60_000;

/**
 * Agent-profile vocabulary. The ontology-graph vocabulary (subject prefix,
 * on-chain id predicate) is owned by context-graph-name-candidate.ts, whose
 * in-memory scan must agree with the SPARQL below.
 */
const SERVED_PREDICATE = 'https://dkg.origintrail.io/skill#contextGraphsServed';

/** Operator-facing identity of a subscription that is (or was) hash-only. */
export interface ContextGraphIdentityNote {
  readonly state: 'name-hash-only' | 'name-hash-only-private' | 'resolved';
  readonly nameHash: string;
  readonly onChainId?: string;
  /** The verified cleartext id, once resolved. */
  readonly contextGraphId?: string;
  readonly message: string;
}

function shortHash(nameHash: string): string {
  return `${nameHash.slice(0, 10)}…${nameHash.slice(-4)}`;
}

/** The waiting-state text, shared by the CLI, the catch-up job and status. */
export function contextGraphNameHashOnlyMessage(nameHash: string): string {
  return `Context Graph ${shortHash(nameHash)} is known only by its on-chain name hash; `
    + 'waiting for a peer to reveal the cleartext id, or subscribe with the cleartext id.';
}

function contextGraphNameHashOnlyPrivateMessage(nameHash: string): string {
  return `Context Graph ${shortHash(nameHash)} is private (curated) and known only by its on-chain name hash; `
    + 'peers never reveal a private graph\'s cleartext id. Ask its curator for the id and an invitation, '
    + 'then subscribe with the cleartext id.';
}

function contextGraphNameResolvedMessage(nameHash: string, contextGraphId: string): string {
  return `Context Graph ${shortHash(nameHash)} resolves to "${contextGraphId}" (verified against the on-chain name hash); `
    + 'it syncs under that id.';
}

interface ContextGraphNameState {
  resolver?: ContextGraphNameResolver;
  /** name hash -> cleartext id, from durable rows including dormant ones. */
  readonly persistedAliases: Map<string, string>;
  /** `${contextGraphId}\0${onChainId}` -> last reveal verdict. */
  readonly verdicts: Map<string, { public: boolean; until: number }>;
  /** Serializes adoption per name hash. */
  readonly adoptions: Map<string, Promise<boolean>>;
}

const contextGraphNameStates = new WeakMap<object, ContextGraphNameState>();

function stateOf(agent: object): ContextGraphNameState {
  let state = contextGraphNameStates.get(agent);
  if (state === undefined) {
    state = {
      persistedAliases: new Map(),
      verdicts: new Map(),
      adoptions: new Map(),
    };
    contextGraphNameStates.set(agent, state);
  }
  return state;
}

/**
 * Split persisted subscription rows into those to activate and hash-keyed
 * placeholders already superseded by a durable cleartext row for the same
 * commitment. A superseded placeholder must not be rehydrated: activating it
 * would re-point the reverse name-hash index at the hash and undo adoption.
 */
export function partitionSupersededContextGraphNamePlaceholders<
  T extends Pick<ContextGraphSubscriptionRecord, 'id' | 'onChainHash'>,
>(rows: readonly T[]): { readonly active: T[]; readonly superseded: T[] } {
  const cleartextByHash = persistedContextGraphIdAliases(rows);
  const active: T[] = [];
  const superseded: T[] = [];
  for (const row of rows) {
    const nameHash = normalizeContextGraphNameHash(row.id);
    const placeholder = nameHash !== null
      && normalizeContextGraphNameHash(row.onChainHash) === nameHash;
    if (placeholder && cleartextByHash.has(nameHash!)) superseded.push(row);
    else active.push(row);
  }
  return { active, superseded };
}

/** name hash -> cleartext id for durable rows whose id is the hash's preimage. */
function persistedContextGraphIdAliases(
  rows: readonly Pick<ContextGraphSubscriptionRecord, 'id' | 'onChainHash'>[],
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const row of rows) {
    const nameHash = normalizeContextGraphNameHash(row.onChainHash);
    if (nameHash === null || row.id.toLowerCase() === nameHash) continue;
    if (verifyContextGraphNameCandidate(row.id, nameHash) === row.id) aliases.set(nameHash, row.id);
  }
  return aliases;
}

export class ContextGraphNameResolutionMethods extends DKGAgentBase {
  /**
   * Register the name protocol (every role: the publisher of a public graph
   * is often an Edge) and start the background resolver. Idempotent.
   */
  startContextGraphNameResolution(this: DKGAgent, lifetimeSignal: AbortSignal): void {
    const state = stateOf(this);
    if (state.resolver !== undefined) return;
    this.router.register(
      PROTOCOL_CONTEXT_GRAPH_NAME,
      createContextGraphNameRequestHandler({
        lookupLocalContextGraphId: (nameHash) => this.lookupLocalContextGraphIdForNameHash(nameHash),
        isPublicContextGraph: (contextGraphId, signal) => (
          this.isContextGraphPublicForNameReveal(contextGraphId, signal)
        ),
      }),
      { maxReadBytes: CONTEXT_GRAPH_NAME_MAX_REQUEST_BYTES },
    );
    const ctx = createOperationContext('sync');
    const resolver = new ContextGraphNameResolver({
      listTargets: () => this.contextGraphNameResolutionTargets(),
      isTargetCurrent: (target) => this.isContextGraphNameTargetCurrent(target),
      classifyPolicy: (target, signal) => this.classifyContextGraphNamePolicy(target, signal),
      findLocalCandidates: (target, signal) => this.findLocalContextGraphNameCandidates(target, signal),
      listPeers: () => this.contextGraphNameResolutionPeers(),
      peerSupportsNameProtocol: (peerId) => this.peerAdvertisesProtocol(peerId, PROTOCOL_CONTEXT_GRAPH_NAME),
      askPeer: (peerId, target, signal) => this.askPeerForContextGraphName(peerId, target, signal),
      pullPeerOntology: (peerId, nameHashes, signal) => (
        this.pullPeerOntologyForContextGraphNames(peerId, nameHashes, signal)
      ),
      adopt: (target, contextGraphId, source) => (
        this.adoptVerifiedContextGraphCleartext(target, contextGraphId, source)
      ),
      log: {
        info: (message) => this.log.info(ctx, message),
        debug: (message) => this.log.debug(ctx, message),
      },
    });
    state.resolver = resolver;
    lifetimeSignal.addEventListener('abort', () => {
      resolver.stop();
      if (stateOf(this).resolver === resolver) stateOf(this).resolver = undefined;
    }, { once: true });
    // Identify completing is the moment a peer's protocol list is known.
    this.node.libp2p.addEventListener('peer:update', (evt) => {
      const peerId = (evt.detail as { peer?: { id?: { toString(): string } } })?.peer?.id?.toString();
      if (peerId !== undefined) resolver.onPeerUpdated(peerId);
    }, { signal: lifetimeSignal });
    resolver.request();
  }

  /**
   * A row just became subscribed or core-hosted. If it is a name-hash
   * placeholder, it cannot sync until its cleartext id is found: wake the
   * resolver now instead of waiting for its next scheduled pass.
   */
  requestContextGraphNameResolutionFor(this: DKGAgent, contextGraphId: string): void {
    const resolver = stateOf(this).resolver;
    if (resolver !== undefined && this.contextGraphNamePlaceholder(contextGraphId) !== null) resolver.request();
  }

  /**
   * A hash-keyed placeholder row: keyed by the lowercase name hash, carrying
   * that same hash as its explicit `onChainHash`, and still the target of the
   * reverse index. A hash-shaped cleartext id never qualifies.
   */
  contextGraphNamePlaceholder(
    this: DKGAgent,
    contextGraphId: string,
  ): { nameHash: string; subscription: ContextGraphSub } | null {
    const nameHash = normalizeContextGraphNameHash(contextGraphId);
    if (nameHash === null) return null;
    const subscription = this.subscribedContextGraphs.get(nameHash);
    if (subscription?.onChainHash === undefined) return null;
    if (this.contextGraphWireId(subscription.onChainHash) !== nameHash) return null;
    const indexed = this.wireIdToLocalCgId.get(nameHash);
    if (indexed !== undefined && indexed !== nameHash) return null;
    return { nameHash, subscription };
  }

  /** Hash-only rows the node actually wants: subscribed or core-hosted, bound on-chain. */
  contextGraphNameResolutionTargets(this: DKGAgent): ContextGraphNameTarget[] {
    const targets: ContextGraphNameTarget[] = [];
    for (const [id, subscription] of this.subscribedContextGraphs) {
      if (subscription.subscribed !== true && subscription.coreHosted !== true) continue;
      const target = this.contextGraphNameTargetFor(id);
      if (target !== null) targets.push(target);
    }
    return targets;
  }

  contextGraphNameTargetFor(this: DKGAgent, contextGraphId: string): ContextGraphNameTarget | null {
    const placeholder = this.contextGraphNamePlaceholder(contextGraphId);
    const onChainId = placeholder?.subscription.onChainId;
    if (placeholder === null || onChainId === undefined || !/^[1-9][0-9]*$/.test(onChainId)) return null;
    return { nameHash: placeholder.nameHash, onChainId };
  }

  isContextGraphNameTargetCurrent(this: DKGAgent, target: ContextGraphNameTarget): boolean {
    return this.contextGraphNamePlaceholder(target.nameHash)?.subscription.onChainId === target.onChainId;
  }

  /**
   * The verified cleartext id this node already adopted for a hash-shaped id,
   * or null. A row keyed by the literal id wins, so a hash-shaped cleartext id
   * is never redirected. Durable rows count even while dormant, so the
   * rehydration kill-switch does not break a `--save`d hash entry.
   */
  resolveContextGraphIdAlias(this: DKGAgent, contextGraphId: string): string | null {
    const nameHash = normalizeContextGraphNameHash(contextGraphId);
    if (nameHash === null) return null;
    if (this.subscribedContextGraphs.has(contextGraphId) || this.subscribedContextGraphs.has(nameHash)) {
      return null;
    }
    const live = this.liveAdoptedContextGraphNameRow(nameHash);
    if (live !== null) return live.contextGraphId;
    const persisted = stateOf(this).persistedAliases.get(nameHash);
    return persisted !== undefined && verifyContextGraphNameCandidate(persisted, nameHash) === persisted
      ? persisted
      : null;
  }

  /**
   * The cleartext id that superseded a retired name-hash id, or null.
   *
   * This is the one statement of the retired-id policy. After adoption no
   * row is keyed by the hash, yet work that captured it earlier (a reconcile
   * pass, a sync, an authority refresh, queued SWM work) may still run. It
   * must never run under the hash: data would land under an id no holder
   * uses, and a policy read would re-hash the hash and report the graph as
   * stale or name-bound elsewhere. Each consumer checks this first and reacts
   * in exactly one of three ways:
   *  - answer for the graph the hash names: the policy reads
   *    `resolveOnChainAccessPolicyState` and `resolveFinalizedOnChainAccessPolicyState`;
   *  - stand down with `SyncTargetSupersededError`, never a stale-mapping or
   *    peer-asset failure: the write gate `requireLocalCgMatchesOnChainSlot`
   *    (durable sync and exact fetch);
   *  - drop the work quietly: VM reconcile (queued and in flight), SWM sync
   *    planning, SWM gossip reconcile, and the RFC-64 authority refresh.
   * The "Base #34 canary" cases in context-graph-name-adoption.test.ts pin
   * each consumer on a real agent, so a composition that lost this method
   * fails there. Consumers call it as `?.` only because they are shared
   * paths that many unit fixtures drive on partial agents. A new entry point
   * that accepts a Context Graph id and writes or re-reads authority under
   * it belongs on this list.
   *
   * Only a live adoption counts: no row is keyed by the hash, a cleartext
   * row carries it as `onChainHash`, keccak256(utf8(cleartext)) equals it,
   * and that row is bound on-chain. A placeholder, an unknown hash or a
   * hash-shaped cleartext id is never superseded, so their fail-closed paths
   * are untouched.
   */
  supersedingContextGraphIdFor(this: DKGAgent, contextGraphId: string): string | null {
    const nameHash = normalizeContextGraphNameHash(contextGraphId);
    if (nameHash === null) return null;
    if (this.subscribedContextGraphs.has(contextGraphId) || this.subscribedContextGraphs.has(nameHash)) {
      return null;
    }
    const live = this.liveAdoptedContextGraphNameRow(nameHash);
    return live !== null && live.subscription.onChainId !== undefined ? live.contextGraphId : null;
  }

  /**
   * The live cleartext row the reverse index holds for a name hash, when it
   * carries that hash as `onChainHash` and is its verified preimage.
   */
  liveAdoptedContextGraphNameRow(
    this: DKGAgent,
    nameHash: string,
  ): { contextGraphId: string; subscription: ContextGraphSub } | null {
    const mapped = this.wireIdToLocalCgId.get(nameHash);
    if (mapped === undefined || mapped === nameHash) return null;
    const subscription = this.subscribedContextGraphs.get(mapped);
    if (
      subscription?.onChainHash === undefined
      || this.contextGraphWireId(subscription.onChainHash) !== nameHash
      || verifyContextGraphNameCandidate(mapped, nameHash) !== mapped
    ) return null;
    return { contextGraphId: mapped, subscription };
  }

  /** Remember durable aliases (called by rehydration with every persisted row). */
  recordPersistedContextGraphIdAliases(
    this: DKGAgent,
    rows: readonly Pick<ContextGraphSubscriptionRecord, 'id' | 'onChainHash'>[],
  ): void {
    const aliases = stateOf(this).persistedAliases;
    for (const [nameHash, contextGraphId] of persistedContextGraphIdAliases(rows)) {
      aliases.set(nameHash, contextGraphId);
    }
  }

  /**
   * Replace sync-scope entries that name an adopted hash with the cleartext id.
   * Operators may have `--save`d the hash; the durable cleartext row is
   * self-authenticating (its commitment is re-checked here), so no peer is
   * trusted twice across restarts.
   */
  rewriteContextGraphSyncScopeAliases(this: DKGAgent): void {
    const scope = this.config.syncContextGraphs;
    if (scope === undefined || scope.length === 0) return;
    let changed = false;
    const rewritten = scope.map((contextGraphId) => {
      const alias = this.resolveContextGraphIdAlias(contextGraphId);
      if (alias === null) return contextGraphId;
      changed = true;
      this.log.info(
        createOperationContext('init'),
        `Configured Context Graph ${contextGraphId} resolves to "${alias}" (verified name hash); `
        + 'syncing under the cleartext id. You can replace the hash in config.contextGraphs.',
      );
      return alias;
    });
    if (changed) this.config.syncContextGraphs = [...new Set(rewritten)];
  }

  /** Diagnostics for status surfaces. */
  getContextGraphNameResolutionStatus(this: DKGAgent): readonly ContextGraphNameResolutionEntry[] {
    return stateOf(this).resolver?.entriesSnapshot() ?? [];
  }

  /**
   * What an operator should be told about one subscription id, or null when
   * the id is an ordinary cleartext subscription.
   */
  describeContextGraphIdentity(this: DKGAgent, contextGraphId: string): ContextGraphIdentityNote | null {
    const alias = this.resolveContextGraphIdAlias(contextGraphId);
    if (alias !== null) {
      const nameHash = normalizeContextGraphNameHash(contextGraphId)!;
      return {
        state: 'resolved',
        nameHash,
        onChainId: this.subscribedContextGraphs.get(alias)?.onChainId,
        contextGraphId: alias,
        message: contextGraphNameResolvedMessage(nameHash, alias),
      };
    }
    const placeholder = this.contextGraphNamePlaceholder(contextGraphId);
    if (placeholder === null) return null;
    const entry = stateOf(this).resolver?.entryFor(placeholder.nameHash);
    const onChainId = placeholder.subscription.onChainId;
    const isPrivate = entry?.state === 'private'
      || (onChainId !== undefined && this.onChainAccessPolicyCache.get(onChainId) === 1);
    return {
      state: isPrivate ? 'name-hash-only-private' : 'name-hash-only',
      nameHash: placeholder.nameHash,
      ...(onChainId === undefined ? {} : { onChainId }),
      message: isPrivate
        ? contextGraphNameHashOnlyPrivateMessage(placeholder.nameHash)
        : contextGraphNameHashOnlyMessage(placeholder.nameHash),
    };
  }

  /**
   * Bounded foreground resolution for one hash-keyed placeholder, subscribed
   * or not (the subscribe route calls this before it subscribes). Returns the
   * adopted cleartext id, or null when nothing verified arrived in time; the
   * background resolver keeps trying either way.
   */
  async resolveContextGraphNameHashNow(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string | null> {
    const existing = this.resolveContextGraphIdAlias(contextGraphId);
    if (existing !== null) return existing;
    const target = this.contextGraphNameTargetFor(contextGraphId);
    const resolver = stateOf(this).resolver;
    if (target === null || resolver === undefined) return null;
    const entry = await resolver.resolveNow(target, options);
    return entry?.state === 'resolved' ? entry.contextGraphId : this.resolveContextGraphIdAlias(contextGraphId);
  }

  // ── Adoption ────────────────────────────────────────────────────────────

  /**
   * Promote a hash-keyed placeholder to its verified cleartext identity.
   *
   * Serialized per name hash and re-validated at commit time, so concurrent
   * resolutions, a racing explicit subscribe, and repeated answers are all
   * idempotent. The canonical setter performs the identity promotion (reverse
   * index, binding generation, RFC-64 responsibility, durable cleanup of the
   * retired row); this method moves the member intent across and restarts
   * sync under the cleartext id.
   */
  adoptVerifiedContextGraphCleartext(
    this: DKGAgent,
    target: ContextGraphNameTarget,
    contextGraphId: string,
    source: ContextGraphNameSource,
  ): Promise<boolean> {
    const adoptions = stateOf(this).adoptions;
    // Wait for the previous adoption of this hash to settle, whatever its outcome.
    const run = Promise.allSettled([adoptions.get(target.nameHash)])
      .then(() => this.adoptVerifiedContextGraphCleartextOnce(target, contextGraphId, source))
      .finally(() => {
        if (adoptions.get(target.nameHash) === run) adoptions.delete(target.nameHash);
      });
    adoptions.set(target.nameHash, run);
    return run;
  }

  private async adoptVerifiedContextGraphCleartextOnce(
    this: DKGAgent,
    target: ContextGraphNameTarget,
    contextGraphId: string,
    source: ContextGraphNameSource,
  ): Promise<boolean> {
    const ctx = createOperationContext('system');
    if (verifyContextGraphNameCandidate(contextGraphId, target.nameHash) !== contextGraphId) return false;
    const placeholder = this.contextGraphNamePlaceholder(target.nameHash);
    if (placeholder === null) {
      // Already promoted by an earlier answer or an explicit subscribe.
      return this.resolveContextGraphIdAlias(target.nameHash) === contextGraphId;
    }
    const hashRow = placeholder.subscription;
    if (hashRow.onChainId !== target.onChainId) return false;
    const cleartextRow = this.subscribedContextGraphs.get(contextGraphId);
    if (cleartextRow?.onChainId !== undefined && cleartextRow.onChainId !== target.onChainId) {
      // Two different on-chain slots share this name commitment. Merging them
      // would splice two graphs together; leave both rows alone.
      this.log.warn(
        ctx,
        `Not adopting "${contextGraphId}" for ${target.nameHash.slice(0, 18)}…: the cleartext row is bound to `
        + `on-chain ${cleartextRow.onChainId}, the name-hash row to ${target.onChainId}`,
      );
      return false;
    }
    const wasSubscribed = hashRow.subscribed === true;
    const wasCoreHosted = hashRow.coreHosted === true;
    const syncMode = hashRow.syncMode ?? 'always-on';

    // Drop the live subscription keyed by the hash (its gossip topics, sync
    // scope and durable member row). The row itself stays for the canonical
    // promotion below.
    if (wasSubscribed) {
      this.unsubscribeFromContextGraph(target.nameHash, { persist: true, supersededBy: contextGraphId });
    }

    // Promote through the canonical setter. The placeholder is the reverse
    // index's target for keccak256(utf8(contextGraphId)) and is bound to the
    // same on-chain id, so the setter adopts it as this id's wire-only row and
    // retires it in memory and durably. An explicit cleartext row that
    // already exists keeps its own settings and gains the binding; the
    // hosting obligation carries across either way.
    this.setContextGraphSubscription(contextGraphId, {
      ...(cleartextRow ?? { syncMode, subscribed: false, synced: false }),
      onChainId: target.onChainId,
      onChainHash: target.nameHash,
      ...(wasCoreHosted ? { coreHosted: true } : {}),
    });

    // Restart sync under the cleartext id: the connected-peer catch-up first,
    // then the chain-driven VM reconcile for anything still missing. They are
    // sequenced because a reconcile pins the subscription row it started from
    // and a catch-up that updates the row would cancel it.
    const triggerReconcile = () => this.vmReconcileScheduling?.triggerLive(contextGraphId);
    if (wasSubscribed) {
      this.subscribeToContextGraph(contextGraphId, { syncMode, onChainId: target.onChainId });
      void this.syncContextGraphFromConnectedPeers(contextGraphId, { includeSharedMemory: true })
        .catch((error: unknown) => {
          this.log.debug(
            ctx,
            `Post-adoption catch-up for "${contextGraphId}" failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(triggerReconcile);
    } else {
      triggerReconcile();
    }
    this.log.info(
      ctx,
      `Adopted cleartext id "${contextGraphId}" for Context Graph name hash ${target.nameHash.slice(0, 18)}… `
      + `(on-chain ${target.onChainId}, source ${source}); syncing under the cleartext id`,
    );
    return true;
  }

  /**
   * Called before any subscribe. When the id is the cleartext of a graph this
   * node subscribed by name hash only, drop the hash-keyed live state (gossip
   * topics, sync scope, durable member row) so the canonical setter's
   * promotion leaves nothing running under the hash.
   */
  retireLiveContextGraphNamePlaceholderFor(this: DKGAgent, contextGraphId: string): void {
    if (this.contextGraphNamePlaceholder(contextGraphId) !== null) return;
    const nameHash = this.contextGraphNameCommitment(contextGraphId);
    const placeholder = this.contextGraphNamePlaceholder(nameHash);
    if (placeholder === null || placeholder.subscription.subscribed !== true) return;
    this.unsubscribeFromContextGraph(nameHash, { persist: true, supersededBy: contextGraphId });
  }

  /**
   * Delete the durable subscription row (and node member row) of a retired
   * name-hash placeholder that was made durable while hash-keyed. Without
   * this, the next rehydration resurrects the hash row.
   *
   * The caller has already removed the in-memory row, so persisting its id
   * projects a `delete` of the durable record: that is the intent here, not
   * a side effect. `row` is the retired row as it was, judged by the same
   * persistence rule that saved it. The write is queued like every other
   * subscription write and ordered by its persist revision.
   */
  retirePersistedContextGraphNamePlaceholder(this: DKGAgent, contextGraphId: string, row: ContextGraphSub): void {
    const persisted = projectContextGraphSubscriptionPersistence({ contextGraphId, subscription: row, syncScoped: false });
    if (persisted.action !== 'save') return;
    if (this.config.contextGraphSubscriptionStore) {
      void this.persistContextGraphSubscription(contextGraphId, {
        revision: this.nextContextGraphSubscriptionPersistRevision(contextGraphId),
        updateRehydrationStatus: true,
      });
    }
    if (persisted.persistMemberIntent && row.subscribed === true) {
      this.deleteContextGraphMember(contextGraphId, 'node', this.peerId);
    }
  }

  // ── Resolver dependencies ───────────────────────────────────────────────

  async classifyContextGraphNamePolicy(
    this: DKGAgent,
    target: ContextGraphNameTarget,
    signal: AbortSignal,
  ): Promise<ContextGraphNamePolicy> {
    const cached = this.onChainAccessPolicyCache.get(target.onChainId);
    if (cached === 0) return 'public';
    if (cached === 1) return 'private';
    const read = this.chain.getContextGraphAccessPolicy;
    if (typeof read !== 'function') return 'unknown';
    try {
      const policy = await runBoundedOperation(
        () => read.call(this.chain, BigInt(target.onChainId)),
        {
          label: `getContextGraphAccessPolicy(${target.onChainId})`,
          timeoutMs: chainAuthorityReadBudgetsOf(this).requestTimeoutMs,
          signal,
        },
      );
      if (policy !== 0 && policy !== 1) return 'unknown';
      // The access policy is fixed at creation, so the answer is cacheable.
      this.onChainAccessPolicyCache.set(target.onChainId, policy);
      return policy === 0 ? 'public' : 'private';
    } catch {
      return 'unknown';
    }
  }

  /** Candidates from the local ontology graph and gossiped agent profiles. */
  async findLocalContextGraphNameCandidates(
    this: DKGAgent,
    target: ContextGraphNameTarget,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(CONTEXT_GRAPH_NAME_LOCAL_SCAN_TIMEOUT_MS)]);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const onChainIdLiteral = JSON.stringify(target.onChainId);
    const queries = [
      // Exact registration binding first: at most a handful of subjects.
      `SELECT DISTINCT ?s WHERE { GRAPH <${ontologyGraph}> { ?s <${CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE}> ?id . `
        + `FILTER(STR(?id) = ${onChainIdLiteral}) } } LIMIT 64`,
      `SELECT DISTINCT ?s WHERE { GRAPH <${ontologyGraph}> { ?s <${DKG_ONTOLOGY.RDF_TYPE}> `
        + `<${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> } } LIMIT ${CONTEXT_GRAPH_NAME_LOCAL_SCAN_MAX_ROWS}`,
      `SELECT DISTINCT ?s WHERE { GRAPH ?g { ?h <${SERVED_PREDICATE}> ?s } `
        + `FILTER(STRSTARTS(STR(?g), ${JSON.stringify(agentsGraph)})) } LIMIT ${CONTEXT_GRAPH_NAME_LOCAL_SCAN_MAX_ROWS}`,
    ];
    for (const [index, sparql] of queries.entries()) {
      readSignal.throwIfAborted();
      let rows: Array<Record<string, string>> = [];
      try {
        const result = await this.store.query(sparql, {
          source: 'agent.contextGraphName.localCandidates',
          signal: readSignal,
        });
        if (result.type === 'bindings') rows = result.bindings as Array<Record<string, string>>;
      } catch {
        continue;
      }
      for (const row of rows) {
        const raw = row['s'];
        if (raw === undefined) continue;
        const candidate = index === 2
          ? stripLiteral(raw)
          : raw.startsWith(CONTEXT_GRAPH_SUBJECT_PREFIX) ? raw.slice(CONTEXT_GRAPH_SUBJECT_PREFIX.length) : undefined;
        if (candidate !== undefined && verifyContextGraphNameCandidate(candidate, target.nameHash) !== null) {
          return [candidate];
        }
      }
    }
    return [];
  }

  /** Connected peers not known to be rejected; cores first (they sync the ontology). */
  contextGraphNameResolutionPeers(this: DKGAgent): readonly string[] {
    const libp2p = this.node.libp2p;
    const connected = new Set(libp2p.getPeers().map((peer) => peer.toString()));
    connected.delete(libp2p.peerId.toString());
    const coordinator = this.networkAdmissionCoordinator;
    const peers = [...connected].filter((peerId) => coordinator === undefined || !coordinator.isRejectedPeer(peerId));
    const isCore = (peerId: string) => this.knownCorePeerIds?.has(peerId) === true;
    return peers.sort((a, b) => (Number(isCore(b)) - Number(isCore(a))) || (a < b ? -1 : a > b ? 1 : 0));
  }

  /** From the identify record: true/false, or undefined while identify is pending. */
  async peerAdvertisesProtocol(this: DKGAgent, peerId: string, protocol: string): Promise<boolean | undefined> {
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const peer = await this.node.libp2p.peerStore.get(peerIdFromString(peerId));
      const protocols = peer.protocols ?? [];
      if (protocols.length === 0) return undefined;
      return protocols.includes(protocol);
    } catch {
      return undefined;
    }
  }

  /**
   * One name request. `router.send` applies the same network admission as
   * every DKG protocol, so only admitted peers are asked. Failures are quiet:
   * an old peer is not an error.
   */
  async askPeerForContextGraphName(
    this: DKGAgent,
    peerId: string,
    target: ContextGraphNameTarget,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (this.networkAdmissionCoordinator?.isRejectedPeer(peerId)) return null;
    try {
      const response = await this.router.send(
        peerId,
        PROTOCOL_CONTEXT_GRAPH_NAME,
        encodeContextGraphNameRequest(target.nameHash),
        {
          timeoutMs: CONTEXT_GRAPH_NAME_ASK_TIMEOUT_MS,
          signal,
          maxReadBytes: CONTEXT_GRAPH_NAME_MAX_RESPONSE_BYTES,
        },
      );
      const decoded = decodeContextGraphNameResponse(response);
      return decoded?.status === 'found' ? decoded.contextGraphId : null;
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      this.log.debug(
        createOperationContext('sync'),
        `Context Graph name request to ${peerId.slice(-8)} ${isProtocolUnsupportedError(error) ? 'not supported' : 'failed'}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Pull the peer's `ontology` system graph over the ordinary sync protocol
   * (every released version serves it to any admitted peer) and scan it in
   * memory. Nothing is inserted, no resume checkpoint survives, and rows that
   * do not match a requested hash are discarded unread.
   */
  async pullPeerOntologyForContextGraphNames(
    this: DKGAgent,
    peerId: string,
    nameHashes: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, string> | null> {
    const ctx = createOperationContext('sync');
    // Local identify record first; admission may probe the network.
    if ((await this.peerAdvertisesProtocol(peerId, PROTOCOL_SYNC)) !== true) return null;
    if (!(await this.ensurePeerAdmittedForRecovery(peerId, ctx, 'Context Graph name ontology peer', signal))) {
      return null;
    }
    const pullSignal = AbortSignal.any([signal, AbortSignal.timeout(CONTEXT_GRAPH_NAME_ONTOLOGY_PULL_TIMEOUT_MS)]);
    try {
      const result = await this.fetchSyncPages(
        ctx,
        peerId,
        SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
        false,
        'data',
        contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
        Date.now() + CONTEXT_GRAPH_NAME_ONTOLOGY_PULL_TIMEOUT_MS,
        {
          signal: pullSignal,
          checkpointStore: new MemorySyncCheckpointStore(),
          ephemeralRequesterState: true,
          forceFreshSession: true,
          maxAcceptedQuads: CONTEXT_GRAPH_NAME_ONTOLOGY_MAX_QUADS,
          maxAcceptedHeapBytesEstimate: CONTEXT_GRAPH_NAME_ONTOLOGY_MAX_HEAP_BYTES,
        },
      );
      const found = new Map<string, string>();
      for (const nameHash of nameHashes) {
        const candidate = findContextGraphNameInOntologyQuads(result.quads, nameHash);
        if (candidate !== null) found.set(nameHash, candidate);
      }
      // An incomplete scan that found nothing proves nothing.
      return result.completed || found.size > 0 ? found : null;
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      this.log.debug(
        ctx,
        `Context Graph name ontology pull from ${peerId.slice(-8)} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // ── Responder ──────────────────────────────────────────────────────────

  /**
   * The cleartext id this node keys a graph under, by a pure map lookup of
   * the hash. A placeholder (the node itself only knows the hash) yields null.
   */
  lookupLocalContextGraphIdForNameHash(this: DKGAgent, nameHash: string): string | null {
    const normalized = normalizeContextGraphNameHash(nameHash);
    if (normalized === null) return null;
    const localId = this.wireIdToLocalCgId.get(normalized);
    if (localId === undefined || localId.toLowerCase() === normalized) return null;
    if (!this.subscribedContextGraphs.has(localId)) return null;
    return contextGraphNameCommitmentOf(localId) === normalized ? localId : null;
  }

  /**
   * Whether this node's own authority state proves the graph public, in the
   * strict form of the node's public-policy gate: the locally bound slot must
   * be live, must commit exactly keccak256(utf8(contextGraphId)), and must
   * have access policy 0. A slot that commits no name or another name proves
   * nothing about this id (a stale binding after a chain reset, say), so it
   * fails closed like private, unregistered, unavailable and errors.
   */
  async isContextGraphPublicForNameReveal(
    this: DKGAgent,
    contextGraphId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const subscription = this.subscribedContextGraphs.get(contextGraphId);
    if (subscription === undefined) return false;
    const { verdicts } = stateOf(this);
    // Policy and name commitment are fixed at creation, so a proof holds for
    // this id and binding; a refusal is remembered briefly to bound repeated
    // chain reads (and fail-closed log lines) from a chatty requester.
    const key = `${contextGraphId}\u0000${subscription.onChainId ?? ''}`;
    const remembered = verdicts.get(key);
    if (remembered !== undefined && (remembered.public || remembered.until > Date.now())) {
      return remembered.public;
    }
    const proof = this.isContextGraphPublicOnChain(
      contextGraphId,
      createOperationContext('sync'),
      { slotBindingMode: 'chain-attested-repair' },
    ).catch(() => false);
    const isPublic = await Promise.race([
      proof,
      new Promise<false>((resolve) => {
        if (signal.aborted) resolve(false);
        else signal.addEventListener('abort', () => resolve(false), { once: true });
      }),
    ]);
    if (!signal.aborted) {
      verdicts.delete(key);
      if (verdicts.size >= MAX_REMEMBERED_REVEAL_VERDICTS) {
        const oldest = verdicts.keys().next().value;
        if (oldest !== undefined) verdicts.delete(oldest);
      }
      verdicts.set(key, { public: isPublic, until: Date.now() + REVEAL_REFUSAL_MEMO_MS });
    }
    return isPublic;
  }
}
