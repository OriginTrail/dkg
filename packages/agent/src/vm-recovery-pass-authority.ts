// SPDX-License-Identifier: Apache-2.0
import type { VmRecoveryAuthorityRetryPolicy } from './vm-recovery-experiment-policy.js';
import type { RegisteredContextGraphAuthority } from './registered-context-graph-authority.js';

/**
 * How long a pass's positive registered-public answer may stand in for the identical read its
 * own exchange would otherwise repeat.
 */
export const VM_RECOVERY_REGISTERED_PUBLIC_MAX_AGE_MS = 90_000;

/**
 * What one exact-recovery pass knows about the graph's registered authority: the repository's
 * own discriminated answer, plus the two states a pass can be in without one.
 */
export type VmRecoveryPassAuthorityObservation =
  | RegisteredContextGraphAuthority
  | { readonly kind: 'not-read' }
  | { readonly kind: 'read-failed' };

/** The recovery operation a handed-over answer belongs to. */
export interface VmRecoveryPassAuthorityOwner {
  readonly contextGraphId: string;
  /** The recovery operation's cancellation signal. */
  readonly signal?: AbortSignal;
  /** Recovery ownership at call time (lifecycle, binding, target). */
  readonly isCurrent: () => boolean;
}

/**
 * A positive registered-public answer, handed explicitly to the exchange of the pass that
 * obtained it. Only that exchange holds it, it is revoked when the exchange returns, and it
 * stays tied to the pass's latest observation, so a later miss withdraws it. Any doubt is
 * `false`, and the exchange then reads the authority itself.
 */
export interface VmRecoveryRegisteredPublicEvidence {
  /**
   * True only while the pass's latest observation is public, no older than
   * {@link VM_RECOVERY_REGISTERED_PUBLIC_MAX_AGE_MS}, for this graph, with the owning operation
   * still current and neither it nor the asker cancelled.
   */
  usableFor(contextGraphId: string, askerSignal?: AbortSignal): boolean;
  /** The exchange it was handed to is over: it can no longer be relied on. */
  revoke(): void;
}

/**
 * The pass-local owner of the registered-authority observation that gates the stream wire.
 * Retry eligibility, the stream decision, the diagnostic label and the answer handed to the
 * pass's own exchange are all derived from the one typed observation, so none of them can
 * drift from the others and no decision branches on a log string. Nothing is carried from
 * one pass to the next: a pass creates its own.
 */
export class VmRecoveryPassAuthority {
  #observation: VmRecoveryPassAuthorityObservation = { kind: 'not-read' };
  #lastReadStartedAt = Number.NEGATIVE_INFINITY;
  #publicObservedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly maxEvidenceAgeMs: number = VM_RECOVERY_REGISTERED_PUBLIC_MAX_AGE_MS,
    private readonly retryPolicy: VmRecoveryAuthorityRetryPolicy = { kind: 'disabled' },
  ) {}

  /**
   * Read once more. Whatever an earlier read of this pass said is superseded by this one, and
   * a read that throws is recorded as `read-failed` rather than propagated.
   */
  async read(
    resolve: () => Promise<RegisteredContextGraphAuthority>,
  ): Promise<VmRecoveryPassAuthorityObservation> {
    this.#lastReadStartedAt = this.clock();
    try {
      this.#observation = await resolve();
    } catch {
      this.#observation = { kind: 'read-failed' };
    }
    if (this.#observation.kind === 'public') this.#publicObservedAt = this.clock();
    return this.#observation;
  }

  get observation(): VmRecoveryPassAuthorityObservation {
    return this.#observation;
  }

  /** A positive answer: the only state that authorizes the stream wire. */
  get isPublic(): boolean {
    return this.#observation.kind === 'public';
  }

  /**
   * The read did not answer. Unlike `private` and `unregistered`, which are answers, this is the
   * transient case worth asking again.
   */
  get missed(): boolean {
    const { kind } = this.#observation;
    return kind === 'unavailable' || kind === 'read-failed';
  }

  /** A miss may be read again only under the pass's configured retry spacing. */
  retryDue(): boolean {
    return this.retryPolicy.kind === 'spaced' && this.missed
      && this.clock() - this.#lastReadStartedAt >= this.retryPolicy.minIntervalMs;
  }

  /** A single bounded miss retry at pass entry; cancellation releases the wait. */
  async waitForMissRetry(signal?: AbortSignal): Promise<boolean> {
    if (!this.missed || this.retryPolicy.kind !== 'spaced') return false;
    await vmRecoveryRetryDelay(this.retryPolicy.minIntervalMs, signal);
    return !signal?.aborted;
  }

  /** The observation as a log label. Observation only: nothing branches on it. */
  get label(): string {
    const observation = this.#observation;
    if (observation.kind === 'unavailable') return `unavailable:${observation.reason}`;
    return observation.kind === 'read-failed' ? 'error' : observation.kind;
  }

  /**
   * A handle for the owning pass to give its own exchange. It reads this observation when it is
   * asked, so it always reflects the pass's latest answer, and it dies when revoked.
   */
  evidence(owner: VmRecoveryPassAuthorityOwner): VmRecoveryRegisteredPublicEvidence {
    let revoked = false;
    return {
      usableFor: (contextGraphId, askerSignal) => {
        if (revoked || this.#observation.kind !== 'public') return false;
        if (contextGraphId !== owner.contextGraphId) return false;
        if (askerSignal?.aborted || owner.signal?.aborted) return false;
        if (this.clock() - this.#publicObservedAt > this.maxEvidenceAgeMs) return false;
        try {
          return owner.isCurrent();
        } catch {
          return false;
        }
      },
      revoke: () => { revoked = true; },
    };
  }
}

/**
 * Resolve after `ms`, or sooner when `signal` aborts. Never rejects and leaves neither
 * a timer nor a listener behind, so a cancelled pass is not held by its own wait.
 */
export function vmRecoveryRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
