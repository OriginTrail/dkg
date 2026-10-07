// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import type { WorkspaceAgentRecipient } from '@origintrail-official/dkg-publisher';
import type { RecipientKeyRouteFence } from './recipient-key-route-fence.js';

interface Collect {
  readonly revision: number;
  readonly promise: Promise<readonly WorkspaceAgentRecipient[]>;
  /** Infinity while in flight; a successful collect gets a short lifetime. */
  expiresAt: number;
}

const copies = (recipients: readonly WorkspaceAgentRecipient[]): WorkspaceAgentRecipient[] => recipients.map((recipient) => ({
  ...recipient,
  publicKeyBytes: recipient.publicKeyBytes && new Uint8Array(recipient.publicKeyBytes),
  privateKeyBytes: recipient.privateKeyBytes && new Uint8Array(recipient.privateKeyBytes),
}));

/** One generation-tagged collect shared by simultaneous resolutions, with owned results. */
export class RecipientKeyCollect {
  private readonly agents = new Map<string, Collect>();

  constructor(
    private readonly fence: RecipientKeyRouteFence,
    private readonly load: (agentAddress: string) => Promise<WorkspaceAgentRecipient[]>,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async resolve(agentAddress: string): Promise<WorkspaceAgentRecipient[]> {
    const agent = ethers.getAddress(agentAddress).toLowerCase();
    if (!this.fence.cacheable) return this.load(agent);
    const revision = this.fence.revision;
    const current = this.agents.get(agent);
    if (current?.revision === revision && current.expiresAt > this.now()) return copies(await current.promise);

    const collect: Collect = {
      revision, expiresAt: Infinity,
      promise: Promise.resolve().then(() => this.load(agent)).then(copies),
    };
    this.agents.delete(agent);
    if (this.agents.size >= 128) this.agents.delete(this.agents.keys().next().value!);
    this.agents.set(agent, collect);
    try {
      const result = await collect.promise;
      if (this.agents.get(agent) === collect) {
        if (this.fence.revision === revision && this.fence.cacheable) collect.expiresAt = this.now() + 1000;
        else this.agents.delete(agent);
      }
      return copies(result);
    } catch (error) {
      if (this.agents.get(agent) === collect) this.agents.delete(agent);
      throw error;
    }
  }
}
