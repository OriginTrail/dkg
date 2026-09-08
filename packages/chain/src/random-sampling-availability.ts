import type { ChainAdapter } from './chain-adapter.js';

/** Chain facts only; the agent owns whether a missing deployment should be retried. */
export type RandomSamplingAvailability =
  | { kind: 'available'; member: boolean }
  | { kind: 'unavailable'; reason: 'unsupported_chain' | 'contracts_not_deployed' }
  | { kind: 'indeterminate'; error: unknown };

export type RandomSamplingAvailabilityReader = Pick<ChainAdapter,
  'isRandomSamplingReady' | 'isShardingTableMember' | 'resolveRandomSamplingAvailability'>;

/** Normalize deployment lookup errors where the adapter's vendor contract is owned. */
export async function probeRandomSamplingAvailability(
  probe: () => Promise<boolean>,
): Promise<RandomSamplingAvailability> {
  try { return { kind: 'available', member: await probe() }; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((message.includes('ShardingTableStorage') || message.includes('RandomSampling'))
      && (message.includes('not found in Hub') || message.includes('not resolvable') || message.includes('not deployed in this Hub'))) {
      return { kind: 'unavailable', reason: 'contracts_not_deployed' };
    }
    return { kind: 'indeterminate', error };
  }
}

/**
 * Prefer an authoritative adapter refresh. Legacy adapters retain their existing
 * readiness/membership checks; no unrelated read is used for hidden cache effects.
 */
export async function resolveRandomSamplingAvailability(
  chain: RandomSamplingAvailabilityReader,
  identityId: bigint,
): Promise<RandomSamplingAvailability> {
  try {
    if (chain.resolveRandomSamplingAvailability) return await chain.resolveRandomSamplingAvailability(identityId);
    if (!chain.isShardingTableMember) return { kind: 'unavailable', reason: 'unsupported_chain' };
    if (chain.isRandomSamplingReady && !chain.isRandomSamplingReady()) {
      return { kind: 'unavailable', reason: 'contracts_not_deployed' };
    }
    return await probeRandomSamplingAvailability(() => chain.isShardingTableMember!(identityId));
  } catch (error) {
    return { kind: 'indeterminate', error };
  }
}
