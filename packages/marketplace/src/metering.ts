/**
 * Buyer-local metering: bigint bucket accounting for the RFC's
 * one-plan/one-meter experience. The meter reserves the worst-case cost at
 * admission (`maxUnits * ask`), settles the actual receipt value when the
 * receipt verifies, and voids the reservation on failure — so the displayed
 * "remaining" is always safe against in-flight calls. Also home to the
 * deterministic unit-counting schedule both buyer and seller use, and the
 * TS mirror of the contract's pro-rata finalization (identical floor math).
 */
import type { MeterBucketState, MeterState, PlanPolicy } from './types.js';

/** Default serve stop: 95% of a bucket (`softCeilingBps` basis points). */
export const DEFAULT_SOFT_CEILING_BPS = 9500;

const WEI_PER_TRAC = 10n ** 18n;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/** Render wei as a decimal TRAC string without floating point. */
export function formatTrac(wei: bigint): string {
  if (wei < 0n) return `-${formatTrac(-wei)}`;
  const whole = wei / WEI_PER_TRAC;
  const fraction = (wei % WEI_PER_TRAC).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Deterministic prototype tokenizer: `ceil(utf8Bytes / 4)`. Buyer and seller
 * MUST use the same schedule or metered units drift from receipt values.
 */
export function countTokens(text: string): bigint {
  const utf8Bytes = BigInt(new TextEncoder().encode(text).length);
  return utf8Bytes === 0n ? 0n : ceilDiv(utf8Bytes, 4n);
}

/**
 * Static query-unit schedule: `10 + ceil(queryUtf8Bytes / 100) + rowCount`.
 * The constant 10 is the per-query admission floor; bytes approximate parse
 * cost and rows approximate result transfer.
 */
export function queryUnits(sparql: string, rowCount: bigint | number): bigint {
  const rows = typeof rowCount === 'bigint' ? rowCount : BigInt(rowCount);
  if (rows < 0n) throw new Error(`rowCount must be non-negative, got: ${rows}`);
  const queryBytes = BigInt(new TextEncoder().encode(sparql).length);
  return 10n + (queryBytes === 0n ? 0n : ceilDiv(queryBytes, 100n)) + rows;
}

export interface SellerClaimValue {
  /** uint72 identity id of the claimant. */
  identityId: bigint;
  claimedWei: bigint;
}

export interface SellerFinalizedValue {
  identityId: bigint;
  finalizedWei: bigint;
}

/**
 * Mirror of `Marketplace.finalizeBucket` value math, kept byte-identical so
 * devnet tests can assert on-chain results against it. When total claims
 * exceed the funded bucket every claimant is pro-rated WITHOUT
 * submission-order priority: `finalized_i = floor(claimed_i * funded /
 * totalClaimed)`; the flooring residue stays in the epoch pool.
 *
 * Sellers with `claimedWei == 0` are SKIPPED (omitted from the result),
 * exactly like the contract's defensive `claimed == 0` guard — a zero entry
 * accrues nothing on-chain and must never divide finalization by zero.
 */
export function proRataFinalize(
  fundedWei: bigint,
  claims: readonly SellerClaimValue[],
): SellerFinalizedValue[] {
  if (fundedWei < 0n) throw new Error(`fundedWei must be non-negative, got: ${fundedWei}`);
  let totalClaimed = 0n;
  for (const claim of claims) {
    if (claim.claimedWei < 0n) throw new Error(`claimedWei must be non-negative, got: ${claim.claimedWei}`);
    totalClaimed += claim.claimedWei;
  }
  return claims
    .filter((claim) => claim.claimedWei > 0n)
    .map((claim) => ({
      identityId: claim.identityId,
      finalizedWei:
        totalClaimed <= fundedWei ? claim.claimedWei : (claim.claimedWei * fundedWei) / totalClaimed,
    }));
}

interface Reservation {
  bucketIndex: number;
  reservedWei: bigint;
}

interface BucketAccount {
  budgetWei: bigint;
  settledWei: bigint;
  reservedWei: bigint;
}

/**
 * Buyer meter over one plan policy (one funded bucket/epoch). Bucket indexes
 * align with `policy.buckets`; all amounts are wei bigints. Reservations are
 * keyed by `callId` (already single-use in the authorization digest).
 */
export class BuyerMeter {
  readonly #totalBudgetWei: bigint;
  readonly #softCeilingBps: number;
  readonly #buckets: BucketAccount[];
  readonly #reservations = new Map<string, Reservation>();
  readonly #resetsLabel: string;

  constructor(policy: PlanPolicy, options: { resetsLabel?: string } = {}) {
    if (policy.totalBudgetWei < 0n) throw new Error('totalBudgetWei must be non-negative');
    this.#totalBudgetWei = policy.totalBudgetWei;
    this.#softCeilingBps = policy.softCeilingBps ?? DEFAULT_SOFT_CEILING_BPS;
    this.#buckets = policy.buckets.map((bucket) => {
      if (bucket.budgetWei < 0n) throw new Error('bucket budgetWei must be non-negative');
      return { budgetWei: bucket.budgetWei, settledWei: 0n, reservedWei: 0n };
    });
    this.#resetsLabel = options.resetsLabel ?? 'at period end';
  }

  #bucket(bucketIndex: number): BucketAccount {
    const bucket = this.#buckets[bucketIndex];
    if (!bucket) throw new Error(`unknown meter bucket index: ${bucketIndex}`);
    return bucket;
  }

  get totalSettledWei(): bigint {
    return this.#buckets.reduce((sum, bucket) => sum + bucket.settledWei, 0n);
  }

  get totalReservedWei(): bigint {
    return this.#buckets.reduce((sum, bucket) => sum + bucket.reservedWei, 0n);
  }

  /** Reserve the worst-case cost of one admitted call. Throws when the
   * bucket or the plan total cannot cover it — the router's soft ceiling
   * should have stopped the call earlier; this is the hard backstop. */
  reserve(bucketIndex: number, callId: string, worstCaseWei: bigint): void {
    if (worstCaseWei <= 0n) throw new Error(`reservation must be positive, got: ${worstCaseWei}`);
    if (this.#reservations.has(callId)) throw new Error(`duplicate reservation for call: ${callId}`);
    const bucket = this.#bucket(bucketIndex);
    const bucketRemaining = bucket.budgetWei - bucket.settledWei - bucket.reservedWei;
    if (worstCaseWei > bucketRemaining) {
      throw new Error(`bucket ${bucketIndex} cannot cover reservation: ${worstCaseWei} > ${bucketRemaining}`);
    }
    const totalRemaining = this.#totalBudgetWei - this.totalSettledWei - this.totalReservedWei;
    if (worstCaseWei > totalRemaining) {
      throw new Error(`plan total cannot cover reservation: ${worstCaseWei} > ${totalRemaining}`);
    }
    bucket.reservedWei += worstCaseWei;
    this.#reservations.set(callId, { bucketIndex, reservedWei: worstCaseWei });
  }

  /** Settle a verified receipt: release the reservation, record the actual
   * value (never more than what was reserved). */
  settle(callId: string, actualWei: bigint): void {
    const reservation = this.#reservations.get(callId);
    if (!reservation) throw new Error(`no reservation for call: ${callId}`);
    if (actualWei < 0n || actualWei > reservation.reservedWei) {
      throw new Error(`settled value ${actualWei} outside reservation 0..${reservation.reservedWei}`);
    }
    const bucket = this.#bucket(reservation.bucketIndex);
    bucket.reservedWei -= reservation.reservedWei;
    bucket.settledWei += actualWei;
    this.#reservations.delete(callId);
  }

  /** Void a reservation after a failed call: the exposure never happened. */
  voidReservation(callId: string): void {
    const reservation = this.#reservations.get(callId);
    if (!reservation) throw new Error(`no reservation for call: ${callId}`);
    this.#bucket(reservation.bucketIndex).reservedWei -= reservation.reservedWei;
    this.#reservations.delete(callId);
  }

  /** Immutable snapshot for the router and status surfaces. */
  snapshot(): MeterState {
    const buckets: MeterBucketState[] = this.#buckets.map((bucket) => ({
      budgetWei: bucket.budgetWei,
      settledWei: bucket.settledWei,
      reservedWei: bucket.reservedWei,
    }));
    return {
      totalBudgetWei: this.#totalBudgetWei,
      softCeilingBps: this.#softCeilingBps,
      totalSettledWei: this.totalSettledWei,
      totalReservedWei: this.totalReservedWei,
      buckets,
    };
  }

  /** The RFC's one-line meter: `used · remaining · resets`. */
  meterSummary(): string {
    const used = this.totalSettledWei;
    const remaining = this.#totalBudgetWei - used - this.totalReservedWei;
    return `used ${formatTrac(used)} TRAC · remaining ${formatTrac(remaining)} TRAC · resets ${this.#resetsLabel}`;
  }
}
