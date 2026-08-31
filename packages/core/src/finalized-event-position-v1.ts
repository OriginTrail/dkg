/**
 * The exact-event-identity model: a finalized event's chain position, its
 * canonical (trust-boundary) validator, ordering and identity. Extracted from
 * `vm-update-convergence.ts` (PR #2436 review r16); NEUTRAL by design (review
 * r17): this module throws plain labeled `Error`s in the same house style as
 * `sync-wire-scalars.ts`, so a publisher validating a position is not handed
 * VM-update terminology. VM convergence adapts these failures into its own
 * typed `VmUpdateConvergenceError` at its boundary, exactly as it already
 * does for the shipped scalar assertions.
 */
import { assertCanonicalDigest, type Digest32V1 } from './sync-wire-scalars.js';

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

/** A canonical 32-byte digest field of a position; length-bounded BEFORE the
 *  shipped regex so an absurd string cannot buy a proportional scan. */
function positionDigest(value: unknown, label: string): Digest32V1 {
  if (typeof value !== 'string' || value.length !== 66) {
    throw new Error(`${label} must be a lowercase 32-byte 0x digest`);
  }
  assertCanonicalDigest(value, label);
  return value;
}

function positionIndex(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Public alias of the position validator (PR #2436 review r5): consumers that
 * decode a LOOSE event payload into `FinalizedEventPositionV1` must use THIS
 * boundary rather than restating `Number.isInteger`-style checks that drift
 * from core's canonical rules (safe integers, lowercase 32-byte digests).
 * Accepts the loose input shape and returns the proven one — the direction a
 * trust boundary is supposed to point. Throws NEUTRAL labeled errors.
 */
export function canonicalEventPositionV1(
  input: LooseEventPositionInputV1,
  label = 'position',
): FinalizedEventPositionV1 {
  return {
    blockNumber: positionIndex(input.blockNumber, `${label}.blockNumber`),
    blockHash: positionDigest(input.blockHash, `${label}.blockHash`),
    transactionHash: positionDigest(input.transactionHash, `${label}.transactionHash`),
    transactionIndex: positionIndex(input.transactionIndex, `${label}.transactionIndex`),
    logIndex: positionIndex(input.logIndex, `${label}.logIndex`),
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
