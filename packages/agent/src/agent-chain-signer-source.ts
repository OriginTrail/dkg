// SPDX-License-Identifier: Apache-2.0
/**
 * Where the agent's own chain adapter takes its operational wallets from:
 * local keys (`operationalKeys`, the first the primary), external signers
 * (`signers`, so the node holds no operational key), or neither, for a
 * configuration whose wallets come with a supplied `chainAdapter` or that
 * writes nothing on-chain. Exclusive, like the chain package's
 * `OperationalSignerSource`, which it is normalized to when the agent builds
 * its adapter.
 */
import type { ExternalEvmSigner, OperationalSignerSource } from '@origintrail-official/dkg-chain';

export type AgentChainSignerSource =
  // A source may be passed as possibly absent (`undefined`), as it always could be.
  | { operationalKeys?: string[]; signers?: never }
  | { signers?: readonly ExternalEvmSigner[]; operationalKeys?: never }
  | { operationalKeys?: never; signers?: never };

/** Where the authors are when the operational wallets sign externally and pay only. */
export interface NodeHeldAuthorConfig {
  /**
   * `chain.signer.nodeHeldAuthor`: the authors are agent keys held on the node (custodial agents),
   * not keys of the external signer. The first one registered becomes the default agent and authors
   * what the node publishes without a selected agent, may curate a context graph backed by a
   * Publishing Conviction Account and sends the sender keys of the curated graphs it is a member of
   * (node-held-author.ts). Applies only when the wallets sign externally; cannot be combined with
   * `authorSigners`. Off (`false` or omitted), nothing changes.
   */
  nodeHeldAuthor?: boolean;
}

/**
 * The adapter's operational signer source from the agent's chain
 * configuration, or undefined when it names none. Exclusivity is checked here
 * too, for callers the types do not reach.
 */
export function operationalSignerSourceOf(chainConfig: {
  readonly operationalKeys?: readonly string[];
  readonly signers?: readonly ExternalEvmSigner[];
}): OperationalSignerSource | undefined {
  const keys = chainConfig.operationalKeys ?? [];
  const signers = chainConfig.signers ?? [];
  if (keys.length > 0 && signers.length > 0) {
    throw new Error('DKGAgentConfig.chainConfig: configure either operationalKeys or signers, not both');
  }
  if (signers.length > 0) return { signers };
  if (keys.length > 0) return { privateKey: keys[0], additionalKeys: keys.slice(1) };
  return undefined;
}
