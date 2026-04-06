import type { Publisher, PublishOptions, PublishResult } from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { paranetDataGraphUri } from '@origintrail-official/dkg-core';
import { buildAgentProfile, AGENT_REGISTRY_CONTEXT_GRAPH, type AgentProfileConfig } from './profile.js';

/**
 * Manages publishing and updating agent profiles as Knowledge Assets
 * in the Agent Registry context graph.
 */
export class ProfileManager {
  private readonly publisher: Publisher;
  private readonly store: TripleStore;
  private currentKcId: bigint | null = null;

  constructor(publisher: Publisher, store: TripleStore) {
    this.publisher = publisher;
    this.store = store;
  }

  async publishProfile(config: AgentProfileConfig): Promise<PublishResult> {
    const { quads, rootEntity } = buildAgentProfile(config);

    // Remove stale triples from prior profile publishes so the data graph
    // contains exactly the triples the merkle root is computed over.
    const dataGraph = paranetDataGraphUri(AGENT_REGISTRY_CONTEXT_GRAPH);
    await this.store.deleteBySubjectPrefix(dataGraph, rootEntity);

    const options: PublishOptions = {
      contextGraphId: AGENT_REGISTRY_CONTEXT_GRAPH,
      quads,
    };

    if (this.currentKcId) {
      const result = await this.publisher.update(this.currentKcId, options);
      this.currentKcId = result.kcId;
      return result;
    }

    const result = await this.publisher.publish(options);
    this.currentKcId = result.kcId;
    return result;
  }

  get profileKcId(): bigint | null {
    return this.currentKcId;
  }
}
