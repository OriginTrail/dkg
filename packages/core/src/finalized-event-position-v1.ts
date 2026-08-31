/**
 * The exact-event-identity model: a finalized event's chain position, its
 * canonical (trust-boundary) validator, ordering and identity. Extracted from
 * `vm-update-convergence.ts` (PR #2436 review r16) as the reusable seam that
 * publishers and agents consume without depending on the full VM-convergence
 * module; that module re-exports these names, so the public core surface is
 * unchanged.
 */
import {
  assertCanonicalDigest,
  type Digest32V1,
} from './sync-wire-scalars.js';
import { adapt, boundedString, fail } from './vm-update-errors.js';

export interface FinalizedEventPositionV1 {
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
}

/**
 * The UNVALIDATED spelling of a position, as read off an untrusted boundary:
 * same keys, every value still unproven. The validator's parameter says so
 * honestly (PR #2436 review r8) — declaring `FinalizedEventPositionV1` here
 * forced callers decoding loose payloads into `as never` casts that made the
 * type boundary claim the input was already canonical.
 */
export type LooseEventPositionInputV1 = { readonly [K in keyof FinalizedEventPositionV1]: unknown };

export function canonicalDigest32(value: unknown, label = 'digest'): Digest32V1 {
  const text = boundedString(value, label);
  return adapt(label, () => {
    assertCanonicalDigest(text, label);
    return text;
  });
}

/** A non-negative safe integer; block numbers and log indices are numbers on this wire. */
export function canonicalBlockNumber(value: unknown, label = 'blockNumber'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('noncanonical-scalar', `${label} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Public alias of the position validator (PR #2436 review r5): consumers that
 * decode a LOOSE event payload into `FinalizedEventPositionV1` must use THIS
 * boundary rather than restating `Number.isInteger`-style checks that drift
 * from core's canonical rules (safe integers, lowercase 32-byte digests).
 * Accepts the loose input shape and returns the proven one — the direction a
 * trust boundary is supposed to point.
 */
export function canonicalEventPositionV1(
  input: LooseEventPositionInputV1,
  label = 'position',
): FinalizedEventPositionV1 {
  return canonicalPosition(input, label);
}

function canonicalPosition(input: LooseEventPositionInputV1, label: string): FinalizedEventPositionV1 {
  return {
    blockNumber: canonicalBlockNumber(input.blockNumber, `${label}.blockNumber`),
    blockHash: canonicalDigest32(input.blockHash, `${label}.blockHash`),
    transactionHash: canonicalDigest32(input.transactionHash, `${label}.transactionHash`),
    transactionIndex: canonicalBlockNumber(input.transactionIndex, `${label}.transactionIndex`),
    logIndex: canonicalBlockNumber(input.logIndex, `${label}.logIndex`),
  };
}

/**
 * Lexicographic order over `(blockNumber, transactionIndex, logIndex)`.
 *
 * `transactionHash` is an identity/equality check, NOT an ordering dimension:
 * ordering by it would make the reducer's resume point depend on hash bytes,
 * which carry no chain order.
 */
export function compareEventPosition(a: FinalizedEventPositionV1, b: FinalizedEventPositionV1): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex < b.transactionIndex ? -1 : 1;
  if (a.logIndex !== b.logIndex) return a.logIndex < b.logIndex ? -1 : 1;
  return 0;
}

export function sameEventIdentity(a: FinalizedEventPositionV1, b: FinalizedEventPositionV1): boolean {
  return (
    compareEventPosition(a, b) === 0 &&
    a.blockHash === b.blockHash &&
    a.transactionHash === b.transactionHash
  );
}
