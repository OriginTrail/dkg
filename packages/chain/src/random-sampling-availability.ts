/** Chain facts only; the agent owns whether a missing deployment should be retried. */
export type RandomSamplingAvailability =
  | { kind: 'available'; member: boolean }
  | { kind: 'unavailable'; reason: 'unsupported_chain' | 'contracts_not_deployed' }
  | { kind: 'indeterminate'; error: unknown };

/** Authoritative resolver capability, derived from the canonical adapter contract. */
export type RandomSamplingAvailabilityResolver = Required<Pick<ChainAdapter, 'resolveRandomSamplingAvailability'>>;

/** Older adapters may offer either or neither compatibility probe. */
export type LegacyRandomSamplingAvailabilityReader = Pick<ChainAdapter, 'isRandomSamplingReady' | 'isShardingTableMember'>;

/** Compatibility input; method declarations remain owned solely by ChainAdapter. */
export type RandomSamplingAvailabilityReader = LegacyRandomSamplingAvailabilityReader & Partial<RandomSamplingAvailabilityResolver>;

/** Typed deployment miss emitted by adapters that own Random Sampling bindings. */
export class RandomSamplingContractsUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'RandomSampling / RandomSamplingStorage not deployed in this Hub. '
      + 'The deployer is responsible for shipping these alongside V10 publish.',
      options,
    );
    this.name = 'RandomSamplingContractsUnavailableError';
  }
}

/** Vendor-neutral compatibility probe for adapters without the typed capability. */
export async function probeRandomSamplingAvailability(
  probe: () => Promise<boolean>,
): Promise<RandomSamplingAvailability> {
  try { return { kind: 'available', member: await probe() }; }
  catch (error) { return { kind: 'indeterminate', error }; }
}

/**
 * Prefer an authoritative adapter refresh. Legacy adapters retain their existing
 * readiness/membership checks; no unrelated read is used for hidden cache effects.
 */
export async function readRandomSamplingAvailability(
  chain: RandomSamplingAvailabilityReader,
  identityId: bigint,
): Promise<RandomSamplingAvailability> {
  try {
    if (chain.resolveRandomSamplingAvailability) return await chain.resolveRandomSamplingAvailability(identityId);
    const membershipProbe = chain.isShardingTableMember;
    if (!membershipProbe) return { kind: 'unavailable', reason: 'unsupported_chain' };
    if (chain.isRandomSamplingReady && !chain.isRandomSamplingReady()) {
      return { kind: 'unavailable', reason: 'contracts_not_deployed' };
    }
    return await probeRandomSamplingAvailability(() => membershipProbe.call(chain, identityId));
  } catch (error) {
    return { kind: 'indeterminate', error };
  }
}
import type { ChainAdapter } from './chain-adapter.js';
