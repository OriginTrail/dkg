/**
 * The default agent of a node whose operational wallets sign through an
 * external signer, which the registry's `reconcileDefaultAgent` settles once at
 * start.
 */
import { ethers } from 'ethers';
import type { ExternalAuthorSigners } from '@origintrail-official/dkg-chain';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import type { DKGAgent } from './dkg-agent.js';

const log = new Logger('DKGAgent');

/**
 * The default agent of a node that signs through an external signer. What the
 * node publishes without a selected agent is authored by the signer's default
 * author, so that author is its default agent, and the drafts the node opens
 * without an agent are the author's too; a node with no agent yet and no
 * default author takes the signer's first author account. That account is
 * registered by address when it is not an agent yet (the signer signs the
 * registration; the node stores no key), under `name` or the first of
 * `<name>-default-author`, `<name>-default-author-2`, … that no agent has, so
 * each default author adopted in turn gets its own name. The other agents stay
 * registered, and their drafts and assets keep their authors. Returns `kept`
 * (the persisted default agent, else the first agent) when there is no such
 * account, or when its registration fails.
 */
export async function externalSignerDefaultAgent(
  agent: DKGAgent,
  authors: ExternalAuthorSigners,
  kept: string | undefined,
  name: string,
  framework?: string,
): Promise<string | undefined> {
  const configured = authors.defaultAuthor?.address ?? (kept === undefined ? authors.addresses[0] : undefined);
  if (configured === undefined) return kept;
  const address = ethers.getAddress(configured);
  if (agent.getLocalAgentMode(address) !== undefined) return address;
  const taken = new Set(agent.listLocalAgents().map((record) => record.name));
  try {
    return (await agent.registerAgent(freeAgentName(taken, name), { address, framework })).agentAddress;
  } catch (err) {
    log.warn(
      createOperationContext('system'),
      `Registering author key ${address} of the external signer as the default agent failed: ` +
        `${err instanceof Error ? err.message : String(err)}; ` +
        (kept === undefined ? 'the node has no default agent' : `keeping ${kept}`),
    );
    return kept;
  }
}

/** `name`, else the first of `<name>-default-author`, `<name>-default-author-2`, … that no agent has. */
function freeAgentName(taken: ReadonlySet<string>, name: string): string {
  if (!taken.has(name)) return name;
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? `${name}-default-author` : `${name}-default-author-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
