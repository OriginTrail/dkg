// SPDX-License-Identifier: Apache-2.0
/**
 * Authors held on the node (`chain.signer.nodeHeldAuthor`, the agent's
 * `nodeHeldAuthor`): an external signer that serves payer accounts only, and an
 * agent key the node holds (a custodial agent) as the node's default agent and
 * author.
 *
 * With the setting on, and the node's wallets signing externally:
 *   - the first agent key registered on the node becomes its default agent at
 *     once, is published in its profile with its encryption keys, and stays the
 *     default agent across restarts (dkg-agent-node-held-author.ts, from
 *     `registerAgent` and `reconcileDefaultAgent`);
 *   - what the node or admin token finalizes or publishes without naming an
 *     agent is authored by that default agent, signed with its key on the node
 *     ({@link nodeHeldDefaultAuthor}): the author attestation, and with it the
 *     update attestations, inventory and catalog objects and gossip envelopes,
 *     which follow the author or the default agent;
 *   - such a key may curate a context graph backed by a Publishing Conviction
 *     Account, whose registration the first payer sends (`isNodeHeldCurator`
 *     in external-author-curator.ts);
 *   - a VM publish into a curated graph sends its shared-memory sender keys as
 *     an agent key on the graph's roster, as a share signs its gossip
 *     ({@link nodeHeldRosterSender}).
 * Off, none of this applies and the node behaves as without the setting: every
 * hook checks the setting first and touches nothing else when it is off.
 */
import { ethers } from 'ethers';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { AgentKeyRecord } from './agent-keystore.js';
import type { NodeHeldAuthorConfig } from './agent-chain-signer-source.js';
import { signsThroughExternalSigner } from './external-author-signing.js';

/** An agent whose key the node holds: custodial, with its private key on file and an EVM address. */
export type NodeHeldAgent = AgentKeyRecord & { privateKey: string };

/** Refuses a `nodeHeldAuthor` that is not a boolean, or one combined with external author keys. */
export function assertNodeHeldAuthorConfig(config: NodeHeldAuthorConfig & { readonly authorSigners?: unknown }): void {
  if (config.nodeHeldAuthor !== undefined && typeof config.nodeHeldAuthor !== 'boolean') {
    throw new Error('DKGAgentConfig.nodeHeldAuthor must be a boolean');
  }
  if (config.nodeHeldAuthor === true && config.authorSigners !== undefined) {
    throw new Error(
      'DKGAgentConfig.nodeHeldAuthor (authors held on the node) cannot be combined with authorSigners (authors in the external signer)',
    );
  }
}

/** Whether `nodeHeldAuthor` is on and the node's wallets sign through an external signer. */
export function nodeHeldAuthorEnabled(
  config: NodeHeldAuthorConfig | undefined,
  chain: Pick<ChainAdapter, 'operationalSigning'> | undefined,
): boolean {
  return config?.nodeHeldAuthor === true && signsThroughExternalSigner(chain);
}

/** Whether `record` is an agent whose key the node holds. */
export function isNodeHeldAgent(record: AgentKeyRecord | undefined): record is NodeHeldAgent {
  return record?.mode === 'custodial'
    && typeof record.privateKey === 'string'
    && record.privateKey.length > 0
    && ethers.isAddress(record.agentAddress);
}

/** The agent registered as `address`, whatever the case of the address given. */
export function localAgentRecord(
  agents: ReadonlyMap<string, AgentKeyRecord>,
  address: string | undefined,
): AgentKeyRecord | undefined {
  if (address === undefined) return undefined;
  const exact = agents.get(address);
  if (exact !== undefined) return exact;
  const lower = address.toLowerCase();
  for (const record of agents.values()) {
    if (record.agentAddress.toLowerCase() === lower) return record;
  }
  return undefined;
}

/**
 * The author of what a node finalizes or publishes without a selected agent when its authors are held
 * on it: its default agent, when the node holds that agent's key. Undefined otherwise, and always with
 * the setting off (nothing but the setting is read then), where the publisher's fallback author applies.
 */
export function nodeHeldDefaultAuthor(
  config: NodeHeldAuthorConfig | undefined,
  chain: Pick<ChainAdapter, 'operationalSigning'> | undefined,
  agents: ReadonlyMap<string, AgentKeyRecord>,
  defaultAgentAddress: string | undefined,
): string | undefined {
  if (!nodeHeldAuthorEnabled(config, chain)) return undefined;
  const record = localAgentRecord(agents, defaultAgentAddress);
  return isNodeHeldAgent(record) ? record.agentAddress : undefined;
}

/**
 * The default agent of a node whose authors are held on it, settled at start:
 * `persisted` when the node holds its key, else the first agent registered with
 * a key on the node (by registration time, then load order). Undefined when the
 * node holds no agent key.
 */
export function nodeHeldDefaultAgent(
  agents: Iterable<AgentKeyRecord>,
  persisted: string | undefined,
): string | undefined {
  const held = [...agents].filter(isNodeHeldAgent);
  const kept = held.find((record) => record.agentAddress.toLowerCase() === persisted?.toLowerCase());
  if (kept !== undefined) return kept.agentAddress;
  const registeredAt = (record: AgentKeyRecord) => {
    const at = Date.parse(record.createdAt);
    return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
  };
  return held.sort((a, b) => registeredAt(a) - registeredAt(b))[0]?.agentAddress;
}

/**
 * The agent that sends the shared-memory sender keys of a VM publish into a
 * curated graph, chosen as a share chooses its gossip signer: `preferred` (the
 * author, else the default agent) when the node holds its key and it is one of
 * the graph's `recipients`, else the first agent with a key on the node that
 * is. Undefined when the node holds the key of no recipient.
 */
export function nodeHeldRosterSender(
  agents: Iterable<AgentKeyRecord>,
  preferred: string | undefined,
  recipients: ReadonlyArray<{ readonly agentAddress: string }>,
): NodeHeldAgent | undefined {
  const roster = new Set(recipients.map((recipient) => recipient.agentAddress.toLowerCase()));
  const held = [...agents].filter(
    (record): record is NodeHeldAgent => isNodeHeldAgent(record) && roster.has(record.agentAddress.toLowerCase()),
  );
  return held.find((record) => record.agentAddress.toLowerCase() === preferred?.toLowerCase()) ?? held[0];
}
