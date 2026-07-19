import type { RatelessMappingParameters } from './configuration.js';
import { ReconciliationError } from './errors.js';

const U64_MASK = 0xffff_ffff_ffff_ffffn;

export interface MappingCursor {
  prngState: bigint;
  lastIndex: number;
}

export function createMappingCursor(seed: bigint): MappingCursor {
  if (seed < 0n || seed > U64_MASK) {
    throw new ReconciliationError('INTEGER_OUT_OF_RANGE', 'mapping seed must be an unsigned 64-bit integer');
  }
  return { prngState: seed, lastIndex: 0 };
}

export function nextMappingIndex(cursor: MappingCursor, parameters: RatelessMappingParameters): number {
  cursor.prngState = (cursor.prngState * parameters.multiplier) & U64_MASK;
  const inverseSqrt = parameters.inverseSqrtNumerator / Math.sqrt(Number(cursor.prngState) + 1);
  const distance = Math.ceil((cursor.lastIndex + parameters.indexOffset) * (inverseSqrt - 1));
  const nextIndex = cursor.lastIndex + Math.max(1, distance);
  if (!Number.isSafeInteger(nextIndex)) {
    throw new ReconciliationError('INTEGER_OUT_OF_RANGE', 'mapping index exceeds the safe integer range');
  }
  cursor.lastIndex = nextIndex;
  return nextIndex;
}

export function expectedMembershipProbability(symbolIndex: number): number {
  if (!Number.isSafeInteger(symbolIndex) || symbolIndex < 0) {
    throw new ReconciliationError('INTEGER_OUT_OF_RANGE', 'symbol index must be a non-negative safe integer');
  }
  return 1 / (1 + symbolIndex / 2);
}
