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
 *    already authenticated), never on unsigned local metadata;
 *  - it asks only currently connected peers, bounded fan-out, first verified
 *    snapshot wins, and it never dials;
 *  - it installs only an unambiguous public root definition
 *    (`requirePublicDefinition`), so a peer cannot flip the graph private;
 *  - it never touches the `ontology` / `agents` system graphs.
 */

import {
  SYSTEM_CONTEXT_GRAPHS,
  createOperationContext,
} from '@origintrail-official/dkg-core';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import { runCuratorMetaRefreshFromPeer } from './curator-meta-refresh.js';

export type Rfc64CatalogMetadataBootstrapOutcomeV1 =
  | 'system-graph'
  | 'local-author'
  | 'not-subscribed'
  | 'no-accepted-public-policy'
  | 'already-confirmed'
  | 'no-connected-peers'
  | 'fetched'
  | 'not-found';

/** One in-flight bootstrap per (agent, graph); concurrent callers share it. */
const rfc64MetadataBootstrapsInFlightV1 = new WeakMap<
  DKGAgent,
  Map<string, Promise<Rfc64CatalogMetadataBootstrapOutcomeV1>>
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
  ): Promise<Rfc64CatalogMetadataBootstrapOutcomeV1> {
    let inFlight = rfc64MetadataBootstrapsInFlightV1.get(this);
    if (inFlight === undefined) {
      inFlight = new Map();
      rfc64MetadataBootstrapsInFlightV1.set(this, inFlight);
    }
    const existing = inFlight.get(contextGraphId);
    if (existing !== undefined) return existing;
    const run = this.runRfc64CatalogContextGraphMetadataBootstrapV1(contextGraphId, signal)
      .finally(() => {
        if (inFlight!.get(contextGraphId) === run) inFlight!.delete(contextGraphId);
      });
    inFlight.set(contextGraphId, run);
    return run;
  }

  private async runRfc64CatalogContextGraphMetadataBootstrapV1(
    this: DKGAgent,
    contextGraphId: string,
    signal?: AbortSignal,
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
    // Fail closed: only an accepted PUBLIC policy may drive this pull. A
    // private graph's metadata arrives through the authenticated join-approval
    // path, and a graph with no accepted policy has no business fetching.
    if (this.readAcceptedRfc64CatalogAccessPolicyV1(contextGraphId) !== 'public') {
      return 'no-accepted-public-policy';
    }
    if (await this.hasConfirmedMetaState(contextGraphId).catch(() => false)) {
      return 'already-confirmed';
    }
    signal?.throwIfAborted();
    // Connected peers only (deduped, self excluded, rejected peers dropped,
    // cores first, deterministic, capped) -- the same candidate set the seed
    // fetch uses, so the two bootstrap steps agree on who is asked.
    const peerIds = this.resolveRfc64UnregisteredAuthoritySeedPeersV1();
    if (peerIds.length === 0) return 'no-connected-peers';

    const ctx = createOperationContext('sync');
    for (const peerId of peerIds) {
      signal?.throwIfAborted();
      // `force` bypasses the auth-probe cooldown: this is an explicit
      // activation event, not a repeated probe. `requirePublicDefinition`
      // rejects any private snapshot outright.
      const refreshed = await runCuratorMetaRefreshFromPeer(this, contextGraphId, peerId, {
        force: true,
        requirePublicDefinition: true,
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
        + `declaration from connected peer ${peerId.slice(-8)}`,
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
}
