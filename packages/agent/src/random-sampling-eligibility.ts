import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { AgentRole, RandomSamplingDisabledReason } from './random-sampling-bind.js';

export type RandomSamplingEligibility =
  | { kind: 'eligible'; identityId: bigint }
  | { kind: 'ineligible' | 'unsupported'; identityId: bigint; reason: RandomSamplingDisabledReason }
  | { kind: 'indeterminate'; reason: RandomSamplingDisabledReason; identityId?: bigint };

export type RandomSamplingEligibilityChain = Pick<ChainAdapter,
  'chainId' | 'getIdentityId' | 'isRandomSamplingReady' | 'isShardingTableMember'> & {
  /** Read-only probe which also refreshes invalidated RandomSampling handles. */
  getActiveProofPeriodStatus?: () => Promise<unknown>;
};

/** Adapter error normalization stays at the chain boundary, independent of runtime state. */
export function classifyRandomSamplingChainError(error: unknown): 'missing-contracts' | 'indeterminate' {
  const message = error instanceof Error ? error.message : String(error);
  return ((message.includes('ShardingTableStorage') || message.includes('RandomSampling'))
    && (message.includes('not found in Hub') || message.includes('not resolvable') || message.includes('not deployed in this Hub')))
    ? 'missing-contracts' : 'indeterminate';
}

export function createRandomSamplingEligibilityResolver(options: {
  role: AgentRole;
  chain: RandomSamplingEligibilityChain;
  log: { warn(message: string): void };
}): () => Promise<RandomSamplingEligibility> {
  const { role, chain, log } = options;
  return async () => {
    if (role !== 'core') return { kind: 'unsupported', identityId: 0n, reason: 'edge_node' };
    if (chain.chainId === 'none') {
      return { kind: 'unsupported', identityId: 0n, reason: 'unsupported_chain' };
    }
    let identityId: bigint;
    try { identityId = await chain.getIdentityId(); }
    catch (error) {
      log.warn(`V10 Random Sampling identity lookup failed; will retry: ${String(error)}`);
      return { kind: 'indeterminate', reason: 'identity_lookup_failed' };
    }
    if (identityId === 0n) return { kind: 'ineligible', identityId, reason: 'no_identity' };
    let failureReason: RandomSamplingDisabledReason = 'bind_failed';
    try {
      // EVM readiness is a cache snapshot. After Hub rotation, a read through
      // the adapter must re-resolve the pair before treating it as absent.
      if (chain.isRandomSamplingReady && !chain.isRandomSamplingReady()) {
        await chain.getActiveProofPeriodStatus?.();
        if (!chain.isRandomSamplingReady()) {
          return { kind: 'unsupported', identityId, reason: 'contracts_not_deployed' };
        }
      }
      if (!chain.isShardingTableMember) return { kind: 'unsupported', identityId, reason: 'unsupported_chain' };
      failureReason = 'eligibility_lookup_failed';
      return await chain.isShardingTableMember(identityId)
        ? { kind: 'eligible', identityId }
        : { kind: 'ineligible', identityId, reason: 'awaiting_sharding_table' };
    } catch (error) {
      if (classifyRandomSamplingChainError(error) === 'missing-contracts') {
        return { kind: 'unsupported', identityId, reason: 'contracts_not_deployed' };
      }
      log.warn(`V10 Random Sampling eligibility lookup failed; will retry: ${String(error)}`);
      return { kind: 'indeterminate', reason: failureReason, identityId };
    }
  };
}
