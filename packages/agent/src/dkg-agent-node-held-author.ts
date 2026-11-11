// SPDX-License-Identifier: Apache-2.0
/**
 * The default agent of a node whose authors are held on it (`nodeHeldAuthor`;
 * the rules are in node-held-author.ts): adopted when its key is registered,
 * and settled at start. `registerAgent` and `reconcileDefaultAgent` call these
 * only when the setting is on.
 */
import { createOperationContext } from '@origintrail-official/dkg-core';
import type { AgentKeyRecord } from './agent-keystore.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import { isNodeHeldAgent, localAgentRecord, nodeHeldAuthorEnabled, nodeHeldDefaultAgent } from './node-held-author.js';
import { installReadGraphWorkingMemoryIdentity } from './read-graph-view-source.js';
// dkg-agent.ts takes the config check from here too, on one import line: it is at its file-size budget.
export { assertNodeHeldAuthorConfig } from './node-held-author.js';

export class NodeHeldAuthorMethods extends DKGAgentBase {
  /**
   * The default agent `reconcileDefaultAgent` settles at start on a node without external author keys:
   * with authors held on the node, the persisted default agent when the node holds its key, else the
   * first agent key registered on the node, else `kept`; otherwise `kept`, as without the setting.
   */
  nodeHeldDefaultAgentOr(this: DKGAgent, kept: string | undefined): string | undefined {
    if (!nodeHeldAuthorEnabled(this.config, this.chain)) return kept;
    return nodeHeldDefaultAgent(this.localAgents.values(), this.defaultAgentAddress) ?? kept;
  }

  /**
   * After `record` was registered: with authors held on the node, an agent key the node holds becomes
   * the default agent at once when the node has none whose key it holds, is marked so across restarts,
   * and is published in the node's profile with its encryption keys. A later key leaves it as it is.
   */
  async adoptNodeHeldDefaultAgent(this: DKGAgent, record: AgentKeyRecord): Promise<void> {
    if (!nodeHeldAuthorEnabled(this.config, this.chain) || !isNodeHeldAgent(record)) return;
    if (isNodeHeldAgent(localAgentRecord(this.localAgents, this.defaultAgentAddress))) return;
    const previous = this.defaultAgentAddress;
    // Taken before anything is awaited, so a concurrent registration finds the default agent taken.
    this.defaultAgentAddress = record.agentAddress;
    // A started node's read graphs follow the new owner of its peer ID's drafts; start installs the rule otherwise.
    if (this.started) await installReadGraphWorkingMemoryIdentity(this.store, { defaultAgentAddress: record.agentAddress, peerId: this.peerId });
    const ctx = createOperationContext('system');
    this.log.info(
      ctx,
      `Default agent is now ${record.agentAddress}, an agent key held on the node (chain.signer.nodeHeldAuthor)` +
        (previous === undefined ? '' : `; was ${previous}`),
    );
    try {
      await this.markDefaultAgent(record.agentAddress);
    } catch (err) {
      this.log.warn(
        ctx,
        `Persisting ${record.agentAddress} as the default agent failed: ${err instanceof Error ? err.message : String(err)}; ` +
          'the next start makes the first agent key held on the node the default agent again',
      );
    }
    try {
      await this.publishProfile();
    } catch (err) {
      this.log.warn(
        ctx,
        `Publishing the profile of default agent ${record.agentAddress} failed: ${err instanceof Error ? err.message : String(err)}; ` +
          'peers learn its encryption keys from the next profile publish',
      );
    }
  }
}
