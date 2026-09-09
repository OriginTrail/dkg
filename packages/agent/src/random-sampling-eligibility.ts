import { readRandomSamplingAvailability, type ChainAdapter, type RandomSamplingAvailabilityReader } from '@origintrail-official/dkg-chain';
import type { AgentRole } from './random-sampling-bind.js';

export type RandomSamplingUnavailable = { kind: 'unavailable'; identityId: bigint; reason:
  | 'edge_node'
  | 'unsupported_chain'
  | 'no_identity'
  | 'awaiting_sharding_table'
  | 'contracts_not_deployed' };

export type RandomSamplingEligibility =
  | { kind: 'eligible'; identityId: bigint }
  | RandomSamplingUnavailable
  | { kind: 'indeterminate'; reason: 'identity_lookup_failed' | 'eligibility_lookup_failed'; identityId?: bigint };

export type RandomSamplingEligibilityChain = Pick<ChainAdapter, 'chainId' | 'getIdentityId'> & RandomSamplingAvailabilityReader;

export function createRandomSamplingEligibilityResolver(options: {
  role: AgentRole;
  chain: RandomSamplingEligibilityChain;
  log: { warn(message: string): void };
}): () => Promise<RandomSamplingEligibility> {
  const { role, chain, log } = options;
  return async () => {
    if (role !== 'core') return { kind: 'unavailable', identityId: 0n, reason: 'edge_node' };
    if (chain.chainId === 'none') return { kind: 'unavailable', identityId: 0n, reason: 'unsupported_chain' };
    let identityId: bigint;
    try { identityId = await chain.getIdentityId(); }
    catch (error) {
      log.warn(`V10 Random Sampling identity lookup failed; will retry: ${String(error)}`);
      return { kind: 'indeterminate', reason: 'identity_lookup_failed' };
    }
    if (identityId === 0n) return { kind: 'unavailable', identityId, reason: 'no_identity' };
    try {
      const availability = await readRandomSamplingAvailability(chain, identityId);
      if (availability.kind === 'indeterminate') throw availability.error;
      if (availability.kind === 'unavailable') return { kind: 'unavailable', identityId, reason: availability.reason };
      return availability.member
        ? { kind: 'eligible', identityId }
        : { kind: 'unavailable', identityId, reason: 'awaiting_sharding_table' };
    } catch (error) {
      log.warn(`V10 Random Sampling eligibility lookup failed; will retry: ${String(error)}`);
      return { kind: 'indeterminate', reason: 'eligibility_lookup_failed', identityId };
    }
  };
}
