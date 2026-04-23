import type { Publisher, PublishOptions, PublishResult } from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { paranetDataGraphUri } from '@origintrail-official/dkg-core';
import {
  buildAgentProfile,
  canonicalAgentDidSubject,
  AGENT_REGISTRY_CONTEXT_GRAPH,
  type AgentProfileConfig,
} from './profile.js';

/**
 * Manages publishing and updating agent profiles as Knowledge Assets
 * in the Agent Registry context graph.
 */
export class ProfileManager {
  private readonly publisher: Publisher;
  private readonly store: TripleStore;
  private currentKcId: bigint | null = null;
  /**
   * Root entity URI used by the most recent publish. Persisted across
   * republishes so an upgraded node cleans up the previous subject
   * (e.g. a legacy `did:dkg:agent:<peerId>` profile) alongside the new
   * one, rather than leaving orphan triples in the data graph.
   */
  private lastRootEntity: string | null = null;

  constructor(publisher: Publisher, store: TripleStore) {
    this.publisher = publisher;
    this.store = store;
  }

  async publishProfile(config: AgentProfileConfig): Promise<PublishResult> {
    const { quads, rootEntity } = buildAgentProfile(config);

    // A-12 review: upgraded nodes that previously published
    // `did:dkg:agent:<peerId>` must drop the legacy subject alongside
    // the new EVM-form subject, otherwise discovery returns the same
    // node twice and the local data graph no longer matches the
    // updated manifest.
    //
    // Codex flagged that `lastRootEntity` is only in memory — a
    // daemon restart after a wallet rotation would forget the
    // previous address-form root. Mitigate by combining a static
    // set of "obvious" prefixes with a one-shot SPARQL scan for
    // any agent subject in the registry graph that claims THIS
    // peerId (`dkg:peerId "<peerId>"`). That covers:
    //   1. legacy peer-id form (`did:dkg:agent:<peerId>`) — always
    //      present on v9/v10-rc nodes before A-12;
    //   2. the canonicalised address form for the current wallet —
    //      handles casing / payload changes between publishes;
    //   3. any OTHER address the same peerId previously published
    //      under — covers the "operator switched wallet + daemon
    //      restart" path that in-memory `lastRootEntity` misses;
    //   4. the remembered `lastRootEntity` — a best-effort fast
    //      path that saves the scan round trip when the prior
    //      address is already known in process;
    //   5. the new `rootEntity` itself — idempotent cleanup when
    //      the publish is a pure content refresh.
    const dataGraph = paranetDataGraphUri(AGENT_REGISTRY_CONTEXT_GRAPH);
    const prefixesToClean = new Set<string>();
    if (this.lastRootEntity) prefixesToClean.add(this.lastRootEntity);
    prefixesToClean.add(`did:dkg:agent:${config.peerId}`);
    if (config.agentAddress) {
      prefixesToClean.add(
        `did:dkg:agent:${canonicalAgentDidSubject(config.agentAddress)}`,
      );
    }
    prefixesToClean.add(rootEntity);

    // Discover any OTHER subject in the registry graph that
    // published with this peerId. SPARQL escape of the peerId
    // literal: the config.peerId is a libp2p base58 peer id (no
    // quotes, no backslashes) but we still guard defensively.
    const escapedPeerId = config.peerId
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
    try {
      const discovered = await this.store.query(
        `SELECT DISTINCT ?s WHERE { GRAPH <${dataGraph}> { ?s <https://dkg.network/ontology#peerId> "${escapedPeerId}" } }`,
      );
      if (discovered.type === 'bindings') {
        for (const row of discovered.bindings) {
          const subject = row['s'];
          if (subject && subject.startsWith('did:dkg:agent:')) {
            prefixesToClean.add(subject);
          }
        }
      }
    } catch {
      // Non-fatal: fall back to the static prefix set. Any
      // orphaned legacy subject will still be cleaned on the
      // next publish where the scan succeeds.
    }

    for (const prefix of prefixesToClean) {
      await this.store.deleteBySubjectPrefix(dataGraph, prefix);
    }

    const options: PublishOptions = {
      contextGraphId: AGENT_REGISTRY_CONTEXT_GRAPH,
      quads,
    };

    if (this.currentKcId) {
      const result = await this.publisher.update(this.currentKcId, options);
      this.currentKcId = result.kcId;
      this.lastRootEntity = rootEntity;
      return result;
    }

    const result = await this.publisher.publish(options);
    this.currentKcId = result.kcId;
    this.lastRootEntity = rootEntity;
    return result;
  }

  get profileKcId(): bigint | null {
    return this.currentKcId;
  }
}
