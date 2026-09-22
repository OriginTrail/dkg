/**
 * Decide which authority-index bootstrap policy the daemon hands to
 * `DKGAgent.create`, once the agent's chain wiring is known.
 *
 * The explicit operator `authorityIndex` block is validated early (before any
 * startup resource is allocated) and always wins. The role default (an edge
 * discovering on-chain cores for snapshot bootstrap) is only satisfiable when
 * the agent will run a real EVM chain adapter with operational keys and a
 * local durable index store: `DKGAgent.create` rejects ANY core-snapshot
 * config, explicit or default, that lacks them. So the daemon decides the
 * default with the same facts the agent checks, and reports why it was skipped
 * instead of announcing an on-chain discovery mode the node would never run.
 *
 * Pure and dependency-free so every combination is unit-testable without
 * booting a daemon; the config type is generic for the same reason.
 */
export interface AuthorityIndexBootstrapDecisionInput<T> {
  /** The validated operator block, or `undefined` when config.json names none. */
  readonly explicitAuthorityIndex: T | undefined;
  readonly nodeRole: 'core' | 'edge';
  /** The daemon projected a complete EVM chain config (`chain.rpcUrl` + `chain.hubAddress`). */
  readonly hasEvmChainConfig: boolean;
  /** The daemon injects the mock chain adapter (`chain.type: "mock"`). */
  readonly usesMockChainAdapter: boolean;
  /** Operational wallets that become the agent's `chainConfig.operationalKeys`. */
  readonly operationalWalletCount: number;
  /** The daemon always constructs its durable store; SDK embedders may omit it. */
  readonly hasLocalAuthorityIndexStore: boolean;
  /** The role default; invoked only for an edge whose preconditions hold. */
  readonly resolveDefault: (nodeRole: 'edge') => T | undefined;
}

export interface AuthorityIndexBootstrapDecision<T> {
  /** What `DKGAgent.create` receives as `authorityIndex`; `undefined` is local history. */
  readonly authorityIndex: T | undefined;
  /** Why the discovered default was skipped; absent when nothing was skipped. */
  readonly reason?: string;
}

export function decideAuthorityIndexBootstrap<T>(
  input: AuthorityIndexBootstrapDecisionInput<T>,
): AuthorityIndexBootstrapDecision<T> {
  if (input.explicitAuthorityIndex !== undefined) {
    return { authorityIndex: input.explicitAuthorityIndex };
  }
  // Cores have no default: they build the index from their own chain history,
  // so there is nothing to skip and no reason to report.
  if (input.nodeRole !== 'edge') return { authorityIndex: undefined };
  const reason = discoveredDefaultSkipReason(input);
  if (reason !== undefined) return { authorityIndex: undefined, reason };
  return { authorityIndex: input.resolveDefault('edge') };
}

/**
 * Mirrors the agent's precondition (`chainAdapter` injected, no
 * `chainConfig.operationalKeys`, or no local index store), ordered so the
 * reported reason is the one an operator can act on: a mock chain also has no
 * projected EVM config, and the mock adapter is the more specific fact.
 */
function discoveredDefaultSkipReason(
  input: Pick<
    AuthorityIndexBootstrapDecisionInput<unknown>,
    'hasEvmChainConfig' | 'usesMockChainAdapter' | 'operationalWalletCount' | 'hasLocalAuthorityIndexStore'
  >,
): string | undefined {
  if (input.usesMockChainAdapter) {
    return 'the node runs the mock chain adapter (chain.type is "mock")';
  }
  if (!input.hasEvmChainConfig) {
    return 'no EVM chain is configured (chain.rpcUrl and chain.hubAddress are required)';
  }
  if (input.operationalWalletCount <= 0) {
    return 'no operational wallet is configured (wallets.json has no operational keys)';
  }
  if (!input.hasLocalAuthorityIndexStore) {
    return 'no local authority index store is available';
  }
  return undefined;
}
