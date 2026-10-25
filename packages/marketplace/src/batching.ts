/**
 * Seller-side receipt batching: accumulate verified receipts per epoch and
 * decide when a batch is worth the on-chain submission. Pure decision logic
 * with an injected clock — the agent's flush timer owns the actual
 * `submitReceiptBatch` call. A batch becomes due when it reaches
 * `maxBatchSize` claims, when its oldest claim has waited `maxDelayMs`, or
 * adaptively when any buyer's unsubmitted exposure in the epoch crosses
 * `maxBuyerExposureWei` (the longer receipts sit locally, the more value is
 * exposed to a bucket being over-claimed by other sellers first — exposure
 * past the threshold is submitted immediately).
 */
import type { ReceiptClaimInput } from './types.js';

export type BatchTrigger = 'size' | 'delay' | 'exposure' | 'flush';

export interface ReceiptBatch {
  epoch: bigint;
  claims: ReceiptClaimInput[];
  trigger: BatchTrigger;
}

export interface ReceiptBatcherPolicy {
  /** Hard per-submission bound; the contract rejects oversized batches. */
  maxBatchSize: number;
  /** Oldest pending claim may wait at most this long before submission. */
  maxDelayMs: number;
  /** Per-(buyer, epoch) unsubmitted value that forces immediate submission. */
  maxBuyerExposureWei: bigint;
}

interface PendingClaim {
  claim: ReceiptClaimInput;
  addedAtMs: number;
  valueWei: bigint;
}

export class ReceiptBatcher {
  readonly #policy: ReceiptBatcherPolicy;
  readonly #now: () => number;
  /** Pending claims per epoch (insertion order preserved). */
  readonly #pending = new Map<string, PendingClaim[]>();

  constructor(policy: ReceiptBatcherPolicy, now: () => number = Date.now) {
    if (!Number.isSafeInteger(policy.maxBatchSize) || policy.maxBatchSize < 1) {
      throw new Error(`maxBatchSize must be a positive integer, got: ${policy.maxBatchSize}`);
    }
    if (!Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < 0) {
      throw new Error(`maxDelayMs must be a non-negative integer, got: ${policy.maxDelayMs}`);
    }
    if (policy.maxBuyerExposureWei < 0n) {
      throw new Error(`maxBuyerExposureWei must be non-negative, got: ${policy.maxBuyerExposureWei}`);
    }
    this.#policy = policy;
    this.#now = now;
  }

  add(claim: ReceiptClaimInput): void {
    const valueWei = claim.servedUnits * claim.askPerUnitWei;
    // Defense in depth: the contract rejects zero-value claims
    // (ZeroClaimValue) and one bad claim voids its WHOLE batch on-chain, so a
    // zero-value claim must never ride along with honest receipts.
    if (valueWei <= 0n) {
      throw new Error(
        `zero-value claim refused (callId ${claim.callId}): servedUnits ${claim.servedUnits} × askPerUnitWei ${claim.askPerUnitWei}`,
      );
    }
    const key = claim.epoch.toString();
    const entries = this.#pending.get(key) ?? [];
    entries.push({ claim, addedAtMs: this.#now(), valueWei });
    this.#pending.set(key, entries);
  }

  /**
   * Put already-drained claims back into the queue — the requeue-preserving
   * seam the seller's submission loop uses when a batch fails for a
   * TRANSIENT reason (transport/estimation), so the claims are not forfeited.
   * Claims re-enter at the FRONT of their epoch's queue (rough FIFO) with a
   * fresh `addedAtMs`, so the `maxDelayMs` trigger acts as a natural retry
   * backoff; `dueImmediately` backdates them instead (restart resubmission).
   * Zero-value claims (possible only from a corrupted restore source) are
   * silently dropped — `add()`'s guard, without the throw, because this runs
   * inside failure handling.
   */
  requeue(claims: readonly ReceiptClaimInput[], opts: { dueImmediately?: boolean } = {}): void {
    const addedAtMs = opts.dueImmediately ? this.#now() - this.#policy.maxDelayMs : this.#now();
    // Walk in reverse so unshifting preserves the claims' relative order.
    for (let index = claims.length - 1; index >= 0; index -= 1) {
      const claim = claims[index];
      const valueWei = claim.servedUnits * claim.askPerUnitWei;
      if (valueWei <= 0n) continue;
      const key = claim.epoch.toString();
      const entries = this.#pending.get(key) ?? [];
      entries.unshift({ claim, addedAtMs, valueWei });
      this.#pending.set(key, entries);
    }
  }

  pendingCount(): number {
    let count = 0;
    for (const entries of this.#pending.values()) count += entries.length;
    return count;
  }

  /** Snapshot of every pending claim (persistence seam); insertion order per epoch. */
  pendingClaims(): ReceiptClaimInput[] {
    const claims: ReceiptClaimInput[] = [];
    for (const entries of this.#pending.values()) {
      for (const entry of entries) claims.push(entry.claim);
    }
    return claims;
  }

  /** Unsubmitted claim value for one buyer bucket (wei). */
  pendingExposureWei(buyer: string, epoch: bigint): bigint {
    const normalized = buyer.toLowerCase();
    let exposure = 0n;
    for (const entry of this.#pending.get(epoch.toString()) ?? []) {
      if (entry.claim.buyer.toLowerCase() === normalized) exposure += entry.valueWei;
    }
    return exposure;
  }

  #trigger(entries: PendingClaim[], nowMs: number): BatchTrigger | undefined {
    if (entries.length >= this.#policy.maxBatchSize) return 'size';
    if (entries.length > 0 && nowMs - entries[0].addedAtMs >= this.#policy.maxDelayMs) return 'delay';
    const exposureByBuyer = new Map<string, bigint>();
    for (const entry of entries) {
      const buyer = entry.claim.buyer.toLowerCase();
      const exposure = (exposureByBuyer.get(buyer) ?? 0n) + entry.valueWei;
      if (exposure > this.#policy.maxBuyerExposureWei) return 'exposure';
      exposureByBuyer.set(buyer, exposure);
    }
    return undefined;
  }

  #drain(key: string, entries: PendingClaim[], trigger: BatchTrigger): ReceiptBatch {
    const taken = entries.splice(0, this.#policy.maxBatchSize);
    if (entries.length === 0) this.#pending.delete(key);
    return { epoch: taken[0].claim.epoch, claims: taken.map((entry) => entry.claim), trigger };
  }

  /** Drain every batch that is due now; call from the flush timer. */
  collectDue(): ReceiptBatch[] {
    const nowMs = this.#now();
    const batches: ReceiptBatch[] = [];
    // Deleting the key currently being visited is safe during Map iteration.
    for (const [key, entries] of this.#pending.entries()) {
      for (;;) {
        const trigger = this.#trigger(entries, nowMs);
        if (!trigger) break;
        batches.push(this.#drain(key, entries, trigger));
        if (entries.length === 0) break;
      }
    }
    return batches;
  }

  /** Drain everything regardless of triggers (shutdown / forced settle). */
  drainAll(): ReceiptBatch[] {
    const batches: ReceiptBatch[] = [];
    for (const [key, entries] of this.#pending.entries()) {
      while (entries.length > 0) batches.push(this.#drain(key, entries, 'flush'));
    }
    return batches;
  }
}
