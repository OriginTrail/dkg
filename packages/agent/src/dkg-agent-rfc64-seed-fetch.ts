// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 unregistered-authority seed exchange on the DKGAgent.
 *
 * Replica side: when subscription bootstrap proves finalized on-chain absence
 * for a wallet-namespaced Context Graph but this node holds no owner-signed
 * seed, pull the seed from currently connected peers (bounded fan-out, first
 * verified envelope wins), persist it through the keyed seed store, and let
 * the existing finalized-absence reconcile decide. Nothing here accepts
 * authority; the reconcile fences (revision, late chain binding, exact policy
 * shape) remain the only acceptance path.
 *
 * Peer selection keeps the per-attempt fan-out cap but must not starve the
 * only seed holder: configured complete providers for the scope lead, a share
 * of the window is reserved for non-core peers (the author is usually an
 * edge), and each group's window rotates across attempts for one scope so
 * successive retries cover every connected peer instead of re-asking the same
 * eight cores.
 *
 * Provider side: serve the seed from the keyed store. The ontology system
 * graph is consulted only as a DEPRECATED backward-compat fallback for graphs
 * this node created, actively subscribes to, or core-hosts (never for a name
 * that merely appeared in unauthenticated gossip discovery), at most once in
 * flight per scope and with a bounded negative cache, so a remote requester
 * cannot make this node re-run the SPARQL read and its verifications on
 * every query for an absent scope.
 */

import {
  assertContextGraphIdV1,
  assertNetworkIdV1,
  assertSafeIri,
  contextGraphDataGraphUri,
  createOperationContext,
  type ContextGraphIdV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  RFC64_UNREGISTERED_AUTHORITY_MAX_FANOUT_PEERS_V1,
  RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1,
  authenticateRfc64UnregisteredAuthorityEnvelopeV1,
  rfc64UnregisteredAuthorityOwnerV1,
  type Rfc64UnregisteredAuthorityScopeV1,
} from './rfc64/unregistered-authority-transport-v1.js';
// DEPRECATED carrier: the ontology predicate is imported only for the
// backward-compat fallback below. New code must not depend on it.
import { RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1 } from
  './rfc64/unregistered-replica-authority-v1.js';

/** Bound on the deprecated ontology fallback read behind one peer request. */
const RFC64_UNREGISTERED_AUTHORITY_ONTOLOGY_FALLBACK_TIMEOUT_MS_V1 = 5_000;
/**
 * How long an absent compat scope stays negative before the ontology read may
 * run again for it. Graphs created after the keyed store existed never reach
 * this path (their seed is a keyed hit), so the TTL only paces legacy misses.
 */
export const RFC64_UNREGISTERED_AUTHORITY_COMPAT_NEGATIVE_TTL_MS_V1 = 60_000;
/** Hard bound on remembered absent scopes; the oldest entry is evicted first. */
const MAX_COMPAT_NEGATIVE_SCOPES_V1 = 1_024;
const MAX_ONTOLOGY_SEED_ROWS_V1 = 32;
const MAX_ONTOLOGY_SEED_BASE64URL_CHARS_V1 =
  Math.ceil(RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1 * 4 / 3) + 4;
const BASE64URL_LITERAL_V1 = /^"([A-Za-z0-9_-]+)"(?:\^\^<[^>]+>)?$/u;

/**
 * Of the per-attempt fan-out window, how many slots non-core peers keep when
 * any are connected. Cores receive ontology durable sync and are the likeliest
 * seed holders, but the author of an unregistered graph is typically an edge:
 * with eight or more cores connected, a pure cores-first window would never
 * reach it.
 */
export const RFC64_UNREGISTERED_AUTHORITY_RESERVED_NON_CORE_PEERS_V1 = 2;
/** Hard bound on remembered per-scope attempt counters; the oldest is evicted first. */
const MAX_PEER_WINDOW_SCOPES_V1 = 1_024;

export interface Rfc64UnregisteredAuthoritySeedPeerSelectionOptionsV1 {
  /**
   * Scope of the fetch. When given, configured complete providers for the
   * graph lead the window and the per-scope attempt counter rotates each
   * group's window; without it the selection is the deterministic first window.
   */
  readonly contextGraphId?: string;
}

/** Per-agent, per-scope count of peer-window selections (rotation state). */
const rfc64PeerWindowAttemptsV1 = new WeakMap<DKGAgent, Map<string, number>>();

function nextPeerWindowAttempt(agent: DKGAgent, contextGraphId: string): number {
  let attempts = rfc64PeerWindowAttemptsV1.get(agent);
  if (attempts === undefined) {
    attempts = new Map();
    rfc64PeerWindowAttemptsV1.set(agent, attempts);
  }
  const attempt = attempts.get(contextGraphId) ?? 0;
  attempts.delete(contextGraphId);
  if (attempts.size >= MAX_PEER_WINDOW_SCOPES_V1) {
    const oldest = attempts.keys().next().value;
    if (oldest !== undefined) attempts.delete(oldest);
  }
  attempts.set(contextGraphId, attempt + 1);
  return attempt;
}

/**
 * `take` peers from `group` starting at a window offset derived from the
 * attempt number, wrapping modularly, so consecutive attempts tile the group.
 * When the whole group fits, rotation is a no-op.
 */
function rotatedPeerWindow(
  group: readonly string[],
  take: number,
  attempt: number,
): string[] {
  if (take <= 0) return [];
  if (take >= group.length) return [...group];
  const start = (attempt * take) % group.length;
  const window: string[] = [];
  for (let index = 0; index < take; index += 1) {
    window.push(group[(start + index) % group.length]!);
  }
  return window;
}

function comparePeerIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Per-agent serve-side compat state: single-flight, negative cache, one write-through per scope. */
interface Rfc64CompatServeStateV1 {
  readonly inflight: Map<string, Promise<Uint8Array | null>>;
  /** scope key -> epoch ms until which the scope is known absent. */
  readonly negativeUntil: Map<string, number>;
  readonly writeThroughAttempted: Set<string>;
}

const rfc64CompatServeStateV1 = new WeakMap<DKGAgent, Rfc64CompatServeStateV1>();

function compatServeState(agent: DKGAgent): Rfc64CompatServeStateV1 {
  let state = rfc64CompatServeStateV1.get(agent);
  if (state === undefined) {
    state = { inflight: new Map(), negativeUntil: new Map(), writeThroughAttempted: new Set() };
    rfc64CompatServeStateV1.set(agent, state);
  }
  return state;
}

function compatScopeKey(scope: Rfc64UnregisteredAuthorityScopeV1): string {
  return `${scope.networkId}\u0000${scope.contextGraphId}`;
}

function rememberCompatAbsence(state: Rfc64CompatServeStateV1, key: string, now: number): void {
  state.negativeUntil.delete(key);
  if (state.negativeUntil.size >= MAX_COMPAT_NEGATIVE_SCOPES_V1) {
    const oldest = state.negativeUntil.keys().next().value;
    if (oldest !== undefined) state.negativeUntil.delete(oldest);
  }
  state.negativeUntil.set(key, now + RFC64_UNREGISTERED_AUTHORITY_COMPAT_NEGATIVE_TTL_MS_V1);
}

export type Rfc64UnregisteredAuthoritySeedFetchOutcomeV1 =
  | 'service-dormant'
  | 'not-wallet-namespaced'
  | 'already-present'
  | 'no-connected-peers'
  | 'fetched'
  | 'not-found';

export class Rfc64SeedFetchMethods extends DKGAgentBase {
  /**
   * The exact (networkId, contextGraphId) key shared with reconcile and the
   * keyed seed store, or null when this node cannot name a trusted network or
   * the id is not wallet-namespaced (no independently checkable owner).
   */
  resolveRfc64UnregisteredAuthorityScopeV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Rfc64UnregisteredAuthorityScopeV1 | null {
    const networkId = this.config.rfc64CatalogDeploymentProfile?.networkId
      ?? this.config.networkIdentity?.chainId;
    if (networkId === undefined || networkId === 'none') return null;
    try {
      assertNetworkIdV1(networkId);
      assertContextGraphIdV1(contextGraphId);
    } catch {
      return null;
    }
    if (rfc64UnregisteredAuthorityOwnerV1(contextGraphId) === null) return null;
    return Object.freeze({
      networkId: networkId as NetworkIdV1,
      contextGraphId: contextGraphId as ContextGraphIdV1,
    });
  }

  /**
   * Currently connected peers, deduped, without self, known-rejected peers
   * dropped, capped at the fan-out bound, in this order:
   *  1. configured complete SWM providers for the scope (accepted-policy
   *     pins) that are connected right now;
   *  2. core peers (they receive ontology durable sync and are the likeliest
   *     seed holders), deterministic order;
   *  3. non-core peers, deterministic order.
   * At least `RFC64_UNREGISTERED_AUTHORITY_RESERVED_NON_CORE_PEERS_V1` of the
   * remaining slots go to non-cores when any are connected; each group fills
   * from the other when short. With a scope, each group's window starts at an
   * offset rotated per attempt so successive attempts tile every connected
   * peer; without one the selection is the deterministic first window.
   * Unclassified peers are kept: the router probes admission at send time.
   */
  resolveRfc64UnregisteredAuthoritySeedPeersV1(
    this: DKGAgent,
    options: Rfc64UnregisteredAuthoritySeedPeerSelectionOptionsV1 = {},
  ): readonly string[] {
    const libp2p = (this.node as any)?.libp2p;
    if (libp2p === undefined) return Object.freeze([]);
    const localPeerId = libp2p.peerId.toString();
    const connected = new Set<string>();
    for (const peer of libp2p.getPeers() as Array<{ toString(): string }>) {
      connected.add(peer.toString());
    }
    const connections = typeof libp2p.getConnections === 'function'
      ? libp2p.getConnections() as Array<{ remotePeer: { toString(): string } }>
      : [];
    for (const connection of connections) connected.add(connection.remotePeer.toString());
    connected.delete(localPeerId);
    const coordinator = this.networkAdmissionCoordinator;
    const admitted = new Set([...connected].filter(
      (peerId) => coordinator === undefined || !coordinator.isRejectedPeer(peerId),
    ));
    const cap = RFC64_UNREGISTERED_AUTHORITY_MAX_FANOUT_PEERS_V1;
    const { contextGraphId } = options;

    // 1. Provider hint: pins the accepted policy manifest names for this graph
    //    are the peers most likely to hold the complete graph (and its `_meta`).
    const selected: string[] = [];
    if (contextGraphId !== undefined) {
      // Absent on partially wired agents (mixin-prototype tests); a real agent
      // always constructs the runtime before start.
      const runtime = this.rfc64SwmRecoveryRuntimeV1 as
        | Pick<typeof this.rfc64SwmRecoveryRuntimeV1, 'resolveConfiguredCompleteProviderPeerIds'>
        | undefined;
      const pinned = runtime?.resolveConfiguredCompleteProviderPeerIds(contextGraphId) ?? [];
      for (const providerPeerId of pinned) {
        if (selected.length >= cap) break;
        if (admitted.has(providerPeerId) && !selected.includes(providerPeerId)) {
          selected.push(providerPeerId);
        }
      }
    }
    const hinted = new Set(selected);
    const isCore = (peerId: string) => this.knownCorePeerIds?.has(peerId) === true;
    const cores: string[] = [];
    const nonCores: string[] = [];
    for (const peerId of admitted) {
      if (hinted.has(peerId)) continue;
      (isCore(peerId) ? cores : nonCores).push(peerId);
    }
    cores.sort(comparePeerIds);
    nonCores.sort(comparePeerIds);

    // 2./3. Reserve non-core slots, then let each group backfill the other.
    const remaining = cap - selected.length;
    let nonCoreTake = nonCores.length === 0
      ? 0
      : Math.min(
        nonCores.length,
        RFC64_UNREGISTERED_AUTHORITY_RESERVED_NON_CORE_PEERS_V1,
        remaining,
      );
    const coreTake = Math.min(cores.length, remaining - nonCoreTake);
    nonCoreTake = Math.min(nonCores.length, remaining - coreTake);
    const attempt = contextGraphId === undefined ? 0 : nextPeerWindowAttempt(this, contextGraphId);
    selected.push(
      ...rotatedPeerWindow(cores, coreTake, attempt),
      ...rotatedPeerWindow(nonCores, nonCoreTake, attempt),
    );
    return Object.freeze(selected);
  }

  /**
   * Replica bootstrap step: obtain the seed from connected peers when the
   * keyed store has none. The fetched envelope is only persisted (F2 re-verifies
   * before writing); acceptance stays inside reconcileRfc64CatalogAccessAuthorityV1.
   * Throws only on caller abort or a persistence failure; per-peer failures and
   * misses resolve to an outcome so callers can keep the initial denial.
   */
  async fetchRfc64UnregisteredAuthoritySeedFromPeersV1(
    this: DKGAgent,
    contextGraphId: string,
    signal?: AbortSignal,
  ): Promise<Rfc64UnregisteredAuthoritySeedFetchOutcomeV1> {
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) return 'service-dormant';
    const scope = this.resolveRfc64UnregisteredAuthorityScopeV1(contextGraphId);
    if (scope === null) return 'not-wallet-namespaced';
    if (await this.readRfc64UnregisteredAuthoritySeedV1({ ...scope, signal }) !== null) {
      return 'already-present';
    }
    const peerIds = this.resolveRfc64UnregisteredAuthoritySeedPeersV1({
      contextGraphId: scope.contextGraphId,
    });
    if (peerIds.length === 0) return 'no-connected-peers';

    const fetched = await service.fetchUnregisteredAuthorityFromPeers({
      networkId: scope.networkId,
      contextGraphId: scope.contextGraphId,
      peerIds,
      signal,
    });
    if (fetched === null) return 'not-found';
    await this.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
      networkId: scope.networkId,
      contextGraphId: scope.contextGraphId,
      canonicalEnvelopeBytes: fetched.seed.canonicalBytes,
      signal,
    });
    this.log.info(
      createOperationContext('system'),
      `RFC-64 unregistered authority seed for ${contextGraphId} obtained from peer `
      + `${fetched.remotePeerId} (policy ${fetched.seed.policyDigest})`,
    );
    return 'fetched';
  }

  /**
   * Whether this node may consult its own deprecated ontology copy on behalf
   * of a remote requester. Only graphs this node durably created, actively
   * subscribes to (gossip topics live), or core-hosts qualify. A discovery
   * row that merely records a name seen in unauthenticated gossip
   * (`subscribed: false`) must not let a stranger steer local reads.
   */
  private isRfc64CompatSeedServingScopeV1(this: DKGAgent, contextGraphId: string): boolean {
    if (this.localContextGraphProvenance.hasLocalCreate(contextGraphId)) return true;
    const subscription = this.subscribedContextGraphs.get(contextGraphId);
    return subscription?.subscribed === true || subscription?.coreHosted === true;
  }

  /**
   * Provider-side point lookup behind the seed transport. Keyed store first.
   * The ontology system graph is consulted only as a DEPRECATED backward-compat
   * fallback, only for graphs this node created, subscribes to or core-hosts
   * (never a scan on behalf of an arbitrary remote-named graph), at most once
   * in flight per scope, remembered as absent for a bounded TTL, bounded by a
   * short local deadline, and written through once per scope so the next
   * request is a point lookup.
   */
  async readRfc64UnregisteredAuthoritySeedForServingV1(
    this: DKGAgent,
    scope: Rfc64UnregisteredAuthorityScopeV1,
    signal?: AbortSignal,
  ): Promise<Uint8Array | null> {
    const stored = await this.readRfc64UnregisteredAuthoritySeedV1({ ...scope, signal });
    if (stored !== null) return stored;
    if (!this.isRfc64CompatSeedServingScopeV1(scope.contextGraphId)) return null;

    const state = compatServeState(this);
    const key = compatScopeKey(scope);
    const now = Date.now();
    const negativeUntil = state.negativeUntil.get(key);
    if (negativeUntil !== undefined) {
      if (negativeUntil > now) return null;
      state.negativeUntil.delete(key);
    }

    // DEPRECATED: ontology system-graph carrier, backward-compat only. Graphs
    // created before the keyed seed store existed hold their seed solely as an
    // ontology literal on the author. Remove once every author has written
    // through. Single-flight: concurrent requests for one scope share the read
    // and its verifications, and the shared read is bounded by its own local
    // deadline rather than the first requester's stream so one early hang-up
    // cannot fail the siblings.
    let shared = state.inflight.get(key);
    if (shared === undefined) {
      shared = this.readDeprecatedRfc64OntologySeedBytesV1(scope)
        .then(async (compat) => {
          if (compat === null) {
            rememberCompatAbsence(state, key, Date.now());
            return null;
          }
          if (!state.writeThroughAttempted.has(key)) {
            state.writeThroughAttempted.add(key);
            try {
              await this.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
                networkId: scope.networkId,
                contextGraphId: scope.contextGraphId,
                canonicalEnvelopeBytes: compat,
              });
            } catch (cause) {
              // Best-effort, attempted once: the authenticated compat copy
              // still serves and the next request re-reads the carrier.
              this.log.debug(
                createOperationContext('system'),
                `RFC-64 unregistered authority seed write-through failed for ${scope.contextGraphId}: `
                + `${cause instanceof Error ? cause.message : String(cause)}`,
              );
            }
          }
          return compat;
        })
        .finally(() => {
          state.inflight.delete(key);
        });
      state.inflight.set(key, shared);
    }
    const compat = await shared;
    signal?.throwIfAborted();
    return compat;
  }

  /**
   * DEPRECATED ontology-carrier read. Same exact-subject read as
   * loadRfc64UnregisteredReplicaAuthorityV1 but yields the canonical bytes the
   * wire needs. Every row is authenticated with the shared verifier; exactly
   * one distinct generation may be served, conflicting generations serve none.
   * Bounded by a short local deadline only (see the single-flight caller).
   */
  private async readDeprecatedRfc64OntologySeedBytesV1(
    this: DKGAgent,
    scope: Rfc64UnregisteredAuthorityScopeV1,
  ): Promise<Uint8Array | null> {
    const readSignal = AbortSignal.timeout(RFC64_UNREGISTERED_AUTHORITY_ONTOLOGY_FALLBACK_TIMEOUT_MS_V1);
    const graph = contextGraphDataGraphUri('ontology');
    const subject = contextGraphDataGraphUri(scope.contextGraphId);
    const result = await this.store.query(
      `SELECT ?evidence WHERE { GRAPH <${assertSafeIri(graph)}> { ` +
      `<${assertSafeIri(subject)}> ` +
      `<${RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1}> ?evidence . ` +
      `FILTER(isLiteral(?evidence)) } } ` +
      `ORDER BY STR(?evidence) LIMIT ${MAX_ONTOLOGY_SEED_ROWS_V1 + 1}`,
      { source: 'agent.rfc64.unregisteredAuthoritySeedServe', signal: readSignal },
    );
    if (
      result.type !== 'bindings'
      || result.bindings.length === 0
      || result.bindings.length > MAX_ONTOLOGY_SEED_ROWS_V1
    ) return null;

    const accepted = new Map<string, Uint8Array>();
    for (const row of result.bindings) {
      if (readSignal.aborted) throw readSignal.reason;
      const bytes = decodeOntologySeedLiteralV1(row['evidence']);
      if (bytes === null) continue;
      try {
        const verified = await authenticateRfc64UnregisteredAuthorityEnvelopeV1(
          bytes,
          scope,
          verifyControlEnvelopeIssuerSignatureV1,
          readSignal,
        );
        accepted.set(verified.policyDigest, verified.canonicalBytes);
      } catch {
        // Unauthenticated, malformed, wrong-owner, wrong-network and replayed
        // cross-CG values are inert ontology data, never a servable seed.
      }
    }
    if (accepted.size !== 1) return null;
    return accepted.values().next().value ?? null;
  }
}

function decodeOntologySeedLiteralV1(value: string | undefined): Uint8Array | null {
  if (value === undefined) return null;
  const lexical = value.match(BASE64URL_LITERAL_V1)?.[1];
  if (
    lexical === undefined
    || lexical.length === 0
    || lexical.length > MAX_ONTOLOGY_SEED_BASE64URL_CHARS_V1
  ) return null;
  const decoded = Buffer.from(lexical, 'base64url');
  if (
    decoded.byteLength === 0
    || decoded.byteLength > RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1
    || decoded.toString('base64url') !== lexical
  ) return null;
  return Uint8Array.from(decoded);
}
