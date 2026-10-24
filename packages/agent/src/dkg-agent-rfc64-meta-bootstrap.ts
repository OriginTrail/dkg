// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 replica metadata bootstrap for a Context Graph whose receiver lane
 * just became active while peers are already connected (subscribe-after-connect).
 *
 * A catalog-authoritative CG is excluded from legacy durable sync
 * (`legacySyncAllowed: false`), the catalog lane carries KA rows but no Context
 * Graph declaration, and the deprecated `ontology` system graph must not be
 * relied on any more. So unless the graph's own `<cg>/_meta` is pulled
 * explicitly, a late subscriber never learns the declaration: `context-graph
 * info` stays "not found", the legacy read heuristics treat the graph as
 * private, and the catch-up job cannot finalize `metaSynced`.
 *
 * This pull is deliberately narrow and fail-closed:
 *  - it runs only for a live subscription whose accepted RFC-64 policy is
 *    PUBLIC (the owner-signed seed or finalized chain evidence this node has
 *    already authenticated), never on unsigned local metadata; a registered
 *    public graph needs it as much as an unregistered one, because the chain
 *    proves the policy and not the declaration;
 *  - it asks only currently connected peers, bounded fan-out, first verified
 *    snapshot wins, and it never dials;
 *  - when no connected peer serves a declaration of a graph that chain evidence
 *    already says is registered and public (the explicit subscribe's admission
 *    proof, or a policy accepted from finalized chain state), it installs the
 *    canonical public definition from the chain instead: the same atomic
 *    repair and strict metadata-bootstrap chain proof that heal configured
 *    graphs at start, so nothing is installed until the chain binds this exact
 *    id to a live public slot. A member that reaches the graph only through
 *    Cores, which host a registered graph by its chain policy and hold no
 *    declaration, would otherwise never learn it (#3264);
 *  - it installs only an unambiguous public root definition
 *    (`requirePublicDefinition`), so a peer cannot flip the graph private;
 *  - the serving peer is an unauthenticated relay, so the snapshot's chain
 *    registration claims (`OnChainId`, `OnChainHash`, a non-placeholder
 *    `registrationStatus`) are stripped and no subscription chain binding is
 *    applied (`ignoreRegistrationBinding`): a binding comes only from chain
 *    truth through the finalized-index / name-hash paths;
 *  - a snapshot whose `dkg:curator` is not the owner the accepted policy
 *    authenticated is rejected (`expectedCuratorAddress`);
 *  - it never touches the `ontology` / `agents` system graphs.
 */

import {
  SYSTEM_CONTEXT_GRAPHS,
  createOperationContext,
  type OperationContext,
} from '@origintrail-official/dkg-core';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import { holdsAuthoritativePublicDefinitionV1 } from './context-graph-meta-confirmation.js';
import {
  isPublicMetaDurabilityPending,
  repairChainAttestedPublicMetaProjection,
  type ChainAttestedPublicMetaRepairResult,
} from './context-graph-public-meta-repair.js';
import { runCuratorMetaRefreshFromPeer } from './curator-meta-refresh.js';
import { rfc64UnregisteredAuthorityOwnerV1 } from
  './rfc64/unregistered-authority-transport-v1.js';

export type Rfc64CatalogMetadataBootstrapOutcomeV1 =
  | 'system-graph'
  | 'local-author'
  | 'not-subscribed'
  | 'no-accepted-public-policy'
  | 'already-confirmed'
  | 'no-connected-peers'
  | 'fetched'
  /** No connected peer served it; the chain registration attested the canonical definition. */
  | 'chain-attested'
  | 'not-found';

/** Public registration already authenticated by the explicit subscribe route. */
export interface RegisteredPublicMetadataBootstrapProofV1 {
  readonly contextGraphId: string;
  readonly onChainId: string;
}

/** One in-flight bootstrap per (agent, graph); only equivalent authority shares it. */
const rfc64MetadataBootstrapsInFlightV1 = new WeakMap<
  DKGAgent,
  Map<string, {
    proofKey?: string;
    promise: Promise<Rfc64CatalogMetadataBootstrapOutcomeV1>;
  }>
>();

export class Rfc64MetaBootstrapMethods extends DKGAgentBase {
  /**
   * Pull `<cg>/_meta` for a newly active RFC-64 public replica from peers that
   * are connected right now. Resolves with a closed outcome; throws only on
   * caller abort. Every per-peer failure (peer does not know the graph, wire
   * error, rejected snapshot) is a miss, and a miss keeps the local state
   * exactly as it was: no metadata is installed, no lane changes.
   */
  bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(
    this: DKGAgent,
    contextGraphId: string,
    signal?: AbortSignal,
    registeredPublicProof?: Readonly<RegisteredPublicMetadataBootstrapProofV1>,
  ): Promise<Rfc64CatalogMetadataBootstrapOutcomeV1> {
    let inFlight = rfc64MetadataBootstrapsInFlightV1.get(this);
    if (inFlight === undefined) {
      inFlight = new Map();
      rfc64MetadataBootstrapsInFlightV1.set(this, inFlight);
    }
    const proofKey = registeredPublicProof === undefined
      ? undefined
      : `${registeredPublicProof.contextGraphId}\0${registeredPublicProof.onChainId}`;
    const existing = inFlight.get(contextGraphId);
    if (existing !== undefined) {
      if (existing.proofKey === proofKey) return existing.promise;
      // An activation pull without chain admission may be in flight when an
      // explicit subscribe proves public registration. Run that stronger pull
      // after the first generation settles; never reuse its weaker outcome.
      return existing.promise.catch(() => undefined).then(() =>
        this.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(
          contextGraphId, signal, registeredPublicProof,
        ));
    }
    const run = this.runRfc64CatalogContextGraphMetadataBootstrapV1(
      contextGraphId, signal, registeredPublicProof,
    )
      .finally(() => {
        if (inFlight!.get(contextGraphId)?.promise === run) inFlight!.delete(contextGraphId);
      });
    inFlight.set(contextGraphId, { proofKey, promise: run });
    return run;
  }

  private async runRfc64CatalogContextGraphMetadataBootstrapV1(
    this: DKGAgent,
    contextGraphId: string,
    signal?: AbortSignal,
    registeredPublicProof?: Readonly<RegisteredPublicMetadataBootstrapProofV1>,
  ): Promise<Rfc64CatalogMetadataBootstrapOutcomeV1> {
    signal?.throwIfAborted();
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return 'system-graph';
    }
    // The author of record wrote its own `_meta` at create.
    if (this.localContextGraphProvenance.hasLocalCreate(contextGraphId)) return 'local-author';
    if (this.subscribedContextGraphs.get(contextGraphId)?.subscribed !== true) {
      return 'not-subscribed';
    }
    // Fail closed: only authenticated PUBLIC authority may drive this pull. A
    // private graph's metadata arrives through the authenticated join-approval
    // path. An explicit subscribe may already have proved a registered public
    // graph against current chain authority before the catalog service holds
    // that policy. Carry that exact admission proof into this catch-up job;
    // background activation with neither that proof nor an accepted policy
    // never starts a chain read here.
    const accepted = this.readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId);
    if (accepted?.policy.accessPolicy === 1) return 'no-accepted-public-policy';
    const provedRegisteredPublic = registeredPublicProof?.contextGraphId === contextGraphId
      && /^[1-9][0-9]*$/.test(registeredPublicProof.onChainId);
    if (accepted === null && !provedRegisteredPublic) return 'no-accepted-public-policy';
    // Chain evidence that the graph is registered and public: only then may a
    // miss below read the chain for the definition itself.
    const chainAttestable = provedRegisteredPublic
      || accepted?.policy.source.kind === 'finalized-chain';
    // The owner this node already authenticated: the seed signer for an
    // owner-signed policy, otherwise the wallet namespace of the id. A served
    // declaration that names a different curator is not this graph's.
    const expectedCuratorAddress = accepted?.policy.source.kind === 'owner-signed-unregistered'
      ? accepted.policy.source.ownerAddress
      : rfc64UnregisteredAuthorityOwnerV1(contextGraphId) ?? undefined;
    if (expectedCuratorAddress === undefined) return 'no-accepted-public-policy';
    // "Confirmed" here means the declaration is HELD locally. The readiness
    // confirmation (`hasConfirmedMetaState`) is the wrong predicate for that:
    // an active public chain proof confirms a registered public graph on its
    // own, so a replica with no `_meta` at all would skip this pull and never
    // learn the declaration; its listing then shows no access policy and its
    // writes are refused (#3264). A definition installed from the chain whose
    // flush failed is visible but not held: confirmation refuses it until the
    // chain repair, the only path that retries that flush, has completed it.
    const durabilityPending = isPublicMetaDurabilityPending(this.store, contextGraphId);
    if (
      !durabilityPending
      && await holdsAuthoritativePublicDefinitionV1(this.store, contextGraphId).catch(() => false)
    ) {
      return 'already-confirmed';
    }
    signal?.throwIfAborted();
    const ctx = createOperationContext('sync');
    const fromPeers = durabilityPending
      ? 'not-found'
      : await this.pullRfc64PublicDeclarationFromConnectedPeersV1(
        contextGraphId, expectedCuratorAddress, ctx, signal,
      );
    if (fromPeers === 'fetched' || !chainAttestable) return fromPeers;
    return await this.installChainAttestedRfc64PublicDefinitionV1(contextGraphId, ctx, signal)
      ?? fromPeers;
  }

  /** First verified public declaration served by a connected peer, installed. */
  private async pullRfc64PublicDeclarationFromConnectedPeersV1(
    this: DKGAgent,
    contextGraphId: string,
    expectedCuratorAddress: string,
    ctx: OperationContext,
    signal?: AbortSignal,
  ): Promise<'no-connected-peers' | 'fetched' | 'not-found'> {
    // Connected peers only (deduped, self excluded, rejected peers dropped,
    // configured complete providers first, cores next with slots reserved for
    // non-cores, deterministic, capped, window rotated per attempt) -- the
    // same candidate policy the seed fetch uses, scoped to this graph.
    const peerIds = this.resolveRfc64UnregisteredAuthoritySeedPeersV1({ contextGraphId });
    if (peerIds.length === 0) return 'no-connected-peers';

    for (const peerId of peerIds) {
      signal?.throwIfAborted();
      // `force` bypasses the auth-probe cooldown: this is an explicit
      // activation event, not a repeated probe. `requirePublicDefinition`
      // rejects any private snapshot outright. `ignoreRegistrationBinding`
      // strips the peer's chain-registration claims and skips the
      // subscription binding: an arbitrary connected peer is not chain truth.
      const refreshed = await runCuratorMetaRefreshFromPeer(this, contextGraphId, peerId, {
        force: true,
        requirePublicDefinition: true,
        ignoreRegistrationBinding: true,
        expectedCuratorAddress,
        signal,
      });
      if (!refreshed) continue;
      // The same readiness transition every other metadata arrival takes:
      // `metaSynced`, the default RFC-64 responsibility re-projection, and the
      // SWM gossip subscription re-check.
      await this.refreshMetaSyncedFlags([contextGraphId]);
      this.log.info(
        ctx,
        `RFC-64 metadata bootstrap for "${contextGraphId}" installed the public `
        + `declaration (chain binding excluded) from connected peer ${peerId.slice(-8)}`,
      );
      return 'fetched';
    }
    this.log.info(
      ctx,
      `RFC-64 metadata bootstrap for "${contextGraphId}": none of ${peerIds.length} `
      + 'connected peer(s) served a public declaration',
    );
    return 'not-found';
  }

  /**
   * Install the canonical public definition (`rdf:type`, `accessPolicy
   * "public"`) of a registered public graph from the chain, with the repair
   * and proof that heal configured graphs at start: nothing is written unless
   * the strict metadata-bootstrap proof binds this exact id (its name hash
   * included) to a live, public slot, and an existing non-public policy is
   * never overwritten. `undefined` when the chain does not attest it now.
   */
  private async installChainAttestedRfc64PublicDefinitionV1(
    this: DKGAgent,
    contextGraphId: string,
    ctx: OperationContext,
    signal?: AbortSignal,
  ): Promise<'chain-attested' | 'already-confirmed' | undefined> {
    const repair = await repairChainAttestedPublicMetaProjection(
      this.store,
      contextGraphId,
      () => this.resolveActivePublicContextGraphChainProof(contextGraphId, ctx, signal),
    );
    signal?.throwIfAborted();
    if (repair.outcome !== 'projection-complete' && repair.outcome !== 'already-complete') {
      this.log.info(
        ctx,
        `RFC-64 metadata bootstrap for "${contextGraphId}": the chain attests no public `
        + `definition now (${describeChainAttestedRepairV1(repair)})`,
      );
      return undefined;
    }
    // As a peer's declaration does: listings and authority reads see it now,
    // not when the listing cache expires.
    this.contextGraphMetaProjection.markDirty(contextGraphId);
    this.invalidateListContextGraphsCache();
    await this.refreshMetaSyncedFlags([contextGraphId]);
    // Already complete: another arrival installed it meanwhile, or this one
    // resumed the flush of an earlier install.
    if (repair.outcome === 'already-complete') return 'already-confirmed';
    this.log.info(
      ctx,
      `RFC-64 metadata bootstrap for "${contextGraphId}" installed the public `
      + 'definition attested by its chain registration (no connected peer served a declaration)',
    );
    return 'chain-attested';
  }
}

function describeChainAttestedRepairV1(
  repair: Exclude<ChainAttestedPublicMetaRepairResult, { outcome: 'projection-complete' | 'already-complete' }>,
): string {
  switch (repair.outcome) {
    case 'not-chain-attested':
      return repair.chainProof.state === 'not-public'
        ? `chain: ${repair.chainProof.reason}`
        : `chain proof ${repair.chainProof.reason}`;
    case 'conflicting-policy':
      return 'a non-public policy is held locally';
    case 'repair-failed':
      return `install failed (${repair.failureStage}): ${repair.detail}`;
  }
}
