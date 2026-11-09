// SPDX-License-Identifier: Apache-2.0
import type { ExactKnowledgeAssetSyncResult } from './durable-recovery-types.js';
import { vmRecoveryRetryDelay } from './vm-recovery-pass-authority.js';
import { VmRecoveryStreamSetbackPolicy } from './vm-recovery-stream-setback-policy.js';

/**
 * The hold after a refused attempt, and how often a waiting job reads local
 * sync capacity again: the interval the VM reconcile pass's wait uses.
 */
export const PUBLIC_SNAPSHOT_RETRY_MS = 2_500;
/** Upper bound of the hold after repeated refusals. */
export const PUBLIC_SNAPSHOT_MAX_HOLD_MS = 30_000;
/** A wait must end this long before the job's limit: the final coverage read needs the time. */
export const PUBLIC_SNAPSHOT_FINAL_READ_RESERVE_MS = 120_000;
/** The bound of one exact attempt. */
export const PUBLIC_SNAPSHOT_ATTEMPT_TIMEOUT_MS = 120_000;

/**
 * What one exact attempt says about where the job goes next.
 *  - `local-refusal`: this node's sync admission did not take the attempt, so
 *    no peer was asked. Every peer would meet the same refusal.
 *  - `retry-peer`: the peer said it is busy, or a stream it had served before
 *    broke. It keeps its turn and is asked again after its hold-off.
 *  - `answered`: the peer gave its answer for these assets.
 */
export type PublicSnapshotAttemptVerdict = 'local-refusal' | 'retry-peer' | 'answered';

export interface PublicSnapshotPacingOptions {
  readonly contextGraphId: string;
  /** Epoch milliseconds at which the job ends. */
  readonly deadline: number;
  readonly signal: AbortSignal;
  /**
   * The job's ownership fence. It throws on cancellation, shutdown or loss of
   * the graph, and a wait rethrows that within one interval.
   */
  readonly assertCurrent: () => void;
  /** Whether this node's sync admission would take the graph's exact fetch now. */
  readonly canAdmit?: () => boolean;
}

/**
 * The waits of one snapshot job. A refusal that says nothing about the peer's
 * data, because this node's sync capacity was in use or the peer said it was
 * busy, is waited out inside the job's limit instead of failing the job.
 *
 * Local capacity is waited for as the VM reconcile pass waits for it: a
 * jittered hold after each refusal, growing with repeated refusals, then a
 * read of the admission every interval until it would take the attempt. A
 * busy peer keeps its turn under the VM recovery stream setback policy and is
 * asked again after the policy's hold-off, while the other configured peers
 * may be asked meanwhile. The history is the job's own and ends with it.
 */
export class PublicSnapshotRecoveryPacing {
  private readonly setbacks = new VmRecoveryStreamSetbackPolicy();
  private refusals = 0;
  private admissionBarrier?: { wait?: Promise<boolean> };

  constructor(private readonly options: PublicSnapshotPacingOptions) {}

  /** Classify one attempt; `committed` counts the assets this attempt stored. */
  settle(peerId: string, attempt: ExactKnowledgeAssetSyncResult, committed: number): PublicSnapshotAttemptVerdict {
    if (committed === 0 && (attempt.admission === 'local-admission-deferred'
      || (attempt.result?.deferredBackpressure ?? 0) > 0)) {
      this.refusals += 1;
      this.admissionBarrier ??= {};
      return 'local-refusal';
    }
    if (attempt.admission === 'work-started') this.refusals = 0;
    const now = Date.now();
    const outcome = attempt.streamOutcome;
    if (outcome === 'complete') this.setbacks.recordServed(this.options.contextGraphId, peerId, now);
    if (outcome !== 'responder-busy' && outcome !== 'stream-interrupted') return 'answered';
    return this.setbacks.recordSetback(this.options.contextGraphId, peerId, outcome, now).keepsTurn
      ? 'retry-peer'
      : 'answered';
  }

  /** Whether the peer is still inside the hold-off of its last setback. */
  heldOff(peerId: string): boolean {
    return this.setbacks.heldOff(this.options.contextGraphId, peerId, Date.now());
  }

  /** A queued worker must honor a refusal already observed by this job. */
  localAdmissionDeferred(): boolean {
    return this.admissionBarrier !== undefined;
  }

  /** The bound of the next attempt, which never runs past the job's limit. */
  attemptTimeoutMs(): number {
    return Math.max(0, Math.min(PUBLIC_SNAPSHOT_ATTEMPT_TIMEOUT_MS, this.options.deadline - Date.now()));
  }

  /**
   * Wait until local sync admission would take the attempt. False when that
   * cannot happen in time; the job's cancellation or loss of its graph throws.
   */
  waitForAdmission(): Promise<boolean> {
    const barrier = this.admissionBarrier ??= {};
    return barrier.wait ??= this.waitForLocalCapacity().finally(() => {
      if (this.admissionBarrier === barrier) this.admissionBarrier = undefined;
    });
  }

  private async waitForLocalCapacity(): Promise<boolean> {
    const hold = Math.min(PUBLIC_SNAPSHOT_MAX_HOLD_MS, PUBLIC_SNAPSHOT_RETRY_MS * 2 ** (this.refusals - 1));
    if (!(await this.sleep(jitter(hold)))) return false;
    while (!this.admissionAvailable()) {
      if (!(await this.sleep(jitter(PUBLIC_SNAPSHOT_RETRY_MS)))) return false;
    }
    return true;
  }

  /** Wait until one of these peers is past its hold-off, with the same outcomes as `waitForAdmission`. */
  async waitForPeer(peerIds: readonly string[]): Promise<boolean> {
    while (peerIds.length > 0 && peerIds.every(peerId => this.heldOff(peerId))) {
      if (!(await this.sleep(jitter(PUBLIC_SNAPSHOT_RETRY_MS)))) return false;
    }
    return true;
  }

  /** A capacity read that cannot answer falls back to the plain bounded retry. */
  private admissionAvailable(): boolean {
    try {
      return this.options.canAdmit?.() ?? true;
    } catch {
      return true;
    }
  }

  /**
   * Sleep, or return false when the sleep would reach into the final read's
   * reserve. It runs in slices of one interval and checks the job's fence
   * after each, so loss of the graph throws within one interval and
   * cancellation at once.
   */
  private async sleep(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    if (until > this.options.deadline - PUBLIC_SNAPSHOT_FINAL_READ_RESERVE_MS) return false;
    await waitForPublicSnapshotRetry(until, this.options.signal, this.options.assertCurrent);
    return true;
  }
}

/** Half the delay plus a random share of the other half, so waiting jobs do not retry in step. */
function jitter(ms: number): number {
  return Math.round(ms / 2 + Math.random() * (ms / 2));
}


/** Wait to an already bounded instant, retaining cancellation and ownership fences. */
export async function waitForPublicSnapshotRetry(until: number, signal: AbortSignal, assertCurrent: () => void): Promise<void> {
  assertCurrent(); signal.throwIfAborted();
  while (Date.now() < until) {
    await vmRecoveryRetryDelay(Math.min(PUBLIC_SNAPSHOT_RETRY_MS, until - Date.now()), signal);
    assertCurrent(); signal.throwIfAborted();
  }
}
