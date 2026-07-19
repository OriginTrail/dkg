import type { MappingProfile } from './profile.js';

const U64_MASK = 0xffff_ffff_ffff_ffffn;

export interface MappingCursor {
  prngState: bigint;
  lastIndex: number;
}

export function createMappingCursor(seed: bigint): MappingCursor {
  if (seed < 0n || seed > U64_MASK) throw new RangeError('mapping seed must be an unsigned 64-bit integer');
  return { prngState: seed, lastIndex: 0 };
}

export function nextMappingIndex(cursor: MappingCursor, profile: MappingProfile): number {
  cursor.prngState = (cursor.prngState * profile.multiplier) & U64_MASK;
  const inverseSqrt = profile.inverseSqrtNumerator / Math.sqrt(Number(cursor.prngState) + 1);
  const distance = Math.ceil((cursor.lastIndex + profile.indexOffset) * (inverseSqrt - 1));
  const nextIndex = cursor.lastIndex + Math.max(1, distance);
  if (!Number.isSafeInteger(nextIndex)) throw new RangeError('mapping index exceeds the safe integer range');
  cursor.lastIndex = nextIndex;
  return nextIndex;
}

export function expectedMembershipProbability(symbolIndex: number): number {
  if (!Number.isSafeInteger(symbolIndex) || symbolIndex < 0) {
    throw new RangeError('symbol index must be a non-negative safe integer');
  }
  return 1 / (1 + symbolIndex / 2);
}
