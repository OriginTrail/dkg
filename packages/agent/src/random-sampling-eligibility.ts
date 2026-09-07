import { resolveRandomSamplingAvailability, type ChainAdapter, type RandomSamplingAvailabilityReader } from '@origintrail-official/dkg-chain';
import type { AgentRole, RandomSamplingDisabledReason } from './random-sampling-bind.js';

export type RandomSamplingUnavailable =
  | { kind: 'unavailable'; retry: 'never'; identityId: bigint; reason: 'edge_node' | 'unsupported_chain' | 'contracts_not_deployed' }
  | { kind: 'unavailable'; retry: 'poll'; identityId: bigint; reason: 'no_identity' | 'awaiting_sharding_table' | 'contracts_not_deployed' | 'bind_failed' };

export type RandomSamplingEligibility =
  | { kind: 'eligible'; identityId: bigint }
  | RandomSamplingUnavailable
  | { kind: 'indeterminate'; retry: 'poll'; reason: 'identity_lookup_failed' | 'eligibility_lookup_failed'; identityId?: bigint };

export type RandomSamplingEligibilityChain = Pick<ChainAdapter, 'chainId' | 'getIdentityId'> & RandomSamplingAvailabilityReader;

/** Binding follows a positive eligibility result, so disappearing contracts remain retryable. */
export function classifyRandomSamplingBindingFailure(reason: RandomSamplingDisabledReason | null | undefined, identityId: bigint): RandomSamplingUnavailable {
  if (reason === 'edge_node' || reason === 'unsupported_chain') {
    return { kind: 'unavailable', retry: 'never', identityId, reason };
  }
  return {
    kind: 'unavailable', retry: 'poll', identityId,
    reason: reason === 'contracts_not_deployed' || reason === 'no_identity' || reason === 'awaiting_sharding_table' ? reason : 'bind_failed',
  };
}

export function createRandomSamplingEligibilityResolver(options: {
  role: AgentRole;
  chain: RandomSamplingEligibilityChain;
  log: { warn(message: string): void };
}): () => Promise<RandomSamplingEligibility> {
  const { role, chain, log } = options;
  let deploymentObserved = false;
  return async () => {
    if (role !== 'core') return { kind: 'unavailable', retry: 'never', identityId: 0n, reason: 'edge_node' };
    if (chain.chainId === 'none') return { kind: 'unavailable', retry: 'never', identityId: 0n, reason: 'unsupported_chain' };
    let identityId: bigint;
    try { identityId = await chain.getIdentityId(); }
    catch (error) {
      log.warn(`V10 Random Sampling identity lookup failed; will retry: ${String(error)}`);
      return { kind: 'indeterminate', retry: 'poll', reason: 'identity_lookup_failed' };
    }
    if (identityId === 0n) return { kind: 'unavailable', retry: 'poll', identityId, reason: 'no_identity' };
    try {
      const availability = await resolveRandomSamplingAvailability(chain, identityId);
      if (availability.kind === 'indeterminate') throw availability.error;
      if (availability.kind === 'unavailable') {
        if (availability.reason === 'contracts_not_deployed' && deploymentObserved) {
          return { kind: 'unavailable', retry: 'poll', identityId, reason: availability.reason };
        }
        return { kind: 'unavailable', retry: 'never', identityId, reason: availability.reason };
      }
      deploymentObserved = true;
      return availability.member
        ? { kind: 'eligible', identityId }
        : { kind: 'unavailable', retry: 'poll', identityId, reason: 'awaiting_sharding_table' };
    } catch (error) {
      log.warn(`V10 Random Sampling eligibility lookup failed; will retry: ${String(error)}`);
      return { kind: 'indeterminate', retry: 'poll', reason: 'eligibility_lookup_failed', identityId };
    }
  };
}
