import type { Publisher, PublishOptions, PublishResult } from '@dkg/publisher';
import { buildAgentProfile, AGENT_REGISTRY_PARANET, type AgentProfileConfig } from './profile.js';

/**
 * Manages publishing and updating agent profiles as Knowledge Assets
 * in the Agent Registry paranet.
 */
export class ProfileManager {
  private readonly publisher: Publisher;
  private currentKcId: bigint | null = null;

  constructor(publisher: Publisher) {
    this.publisher = publisher;
  }

  async publishProfile(config: AgentProfileConfig): Promise<PublishResult> {
    const { quads } = buildAgentProfile(config);

    const options: PublishOptions = {
      paranetId: AGENT_REGISTRY_PARANET,
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
