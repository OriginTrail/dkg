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
 * Provider side: serve the seed from the keyed store. The ontology system
 * graph is consulted only as a DEPRECATED backward-compat fallback for graphs
 * this node created or subscribes to before the keyed store existed.
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
const MAX_ONTOLOGY_SEED_ROWS_V1 = 32;
const MAX_ONTOLOGY_SEED_BASE64URL_CHARS_V1 =
  Math.ceil(RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1 * 4 / 3) + 4;
const BASE64URL_LITERAL_V1 = /^"([A-Za-z0-9_-]+)"(?:\^\^<[^>]+>)?$/u;

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
   * dropped, core peers first (they receive ontology durable sync and are the
   * likeliest seed holders), deterministic order, capped at the fan-out bound.
   * Unclassified peers are kept: the router probes admission at send time.
   */
  resolveRfc64UnregisteredAuthoritySeedPeersV1(this: DKGAgent): readonly string[] {
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
    const isCore = (peerId: string) => this.knownCorePeerIds?.has(peerId) === true;
    const peers = [...connected]
      .filter((peerId) => coordinator === undefined || !coordinator.isRejectedPeer(peerId))
      .sort((a, b) => {
        const rank = Number(!isCore(a)) - Number(!isCore(b));
        if (rank !== 0) return rank;
        return a < b ? -1 : a > b ? 1 : 0;
      })
      .slice(0, RFC64_UNREGISTERED_AUTHORITY_MAX_FANOUT_PEERS_V1);
    return Object.freeze(peers);
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
    const peerIds = this.resolveRfc64UnregisteredAuthoritySeedPeersV1();
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
   * Provider-side point lookup behind the seed transport. Keyed store first.
   * The ontology system graph is consulted only as a DEPRECATED backward-compat
   * fallback, only for graphs this node created or subscribes to (never a scan
   * on behalf of an arbitrary remote-named graph), bounded by the handler
   * signal and a short local deadline, and written through so the next request
   * is a point lookup.
   */
  async readRfc64UnregisteredAuthoritySeedForServingV1(
    this: DKGAgent,
    scope: Rfc64UnregisteredAuthorityScopeV1,
    signal?: AbortSignal,
  ): Promise<Uint8Array | null> {
    const stored = await this.readRfc64UnregisteredAuthoritySeedV1({ ...scope, signal });
    if (stored !== null) return stored;
    if (
      !this.localContextGraphProvenance.hasLocalCreate(scope.contextGraphId)
      && !this.subscribedContextGraphs.has(scope.contextGraphId)
    ) return null;

    // DEPRECATED: ontology system-graph carrier, backward-compat only. Graphs
    // created before the keyed seed store existed hold their seed solely as an
    // ontology literal on the author. Remove once every author has written
    // through.
    const compat = await this.readDeprecatedRfc64OntologySeedBytesV1(scope, signal);
    if (compat === null) return null;
    try {
      await this.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
        networkId: scope.networkId,
        contextGraphId: scope.contextGraphId,
        canonicalEnvelopeBytes: compat,
        signal,
      });
    } catch (cause) {
      // Best-effort write-through; the authenticated compat copy still serves.
      this.log.warn(
        createOperationContext('system'),
        `RFC-64 unregistered authority seed write-through failed for ${scope.contextGraphId}: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return compat;
  }

  /**
   * DEPRECATED ontology-carrier read. Same exact-subject read as
   * loadRfc64UnregisteredReplicaAuthorityV1 but yields the canonical bytes the
   * wire needs. Every row is authenticated with the shared verifier; exactly
   * one distinct generation may be served, conflicting generations serve none.
   */
  private async readDeprecatedRfc64OntologySeedBytesV1(
    this: DKGAgent,
    scope: Rfc64UnregisteredAuthorityScopeV1,
    signal?: AbortSignal,
  ): Promise<Uint8Array | null> {
    const deadline = AbortSignal.timeout(RFC64_UNREGISTERED_AUTHORITY_ONTOLOGY_FALLBACK_TIMEOUT_MS_V1);
    const readSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
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
