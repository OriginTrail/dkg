// SPDX-License-Identifier: Apache-2.0

import type { StoreOperation } from './store-operation-outcome.js';

export interface ManagedReadRecoveryStateV1 {
  readonly recovering: boolean;
  readonly generation: number;
}

export interface ManagedReadRecoveryTokenV1 {
  readonly lifecycleGeneration: number;
  readonly storeGeneration: number;
}

export interface ManagedReadRecoveryCapabilityV1 {
  readonly readState: () => ManagedReadRecoveryStateV1;
  readonly recover: (operation: StoreOperation) => void;
}

export interface ManagedReadRecoveryCoordinatorOptionsV1 {
  readonly now: () => number;
  readonly capability?: ManagedReadRecoveryCapabilityV1;
  /** Retained server work fences maintenance after caller-visible cancellation. */
  readonly onPendingChange?: (pending: boolean) => void;
}

/**
 * Own the retained deadline for managed server work whose HTTP request was
 * dispatched before caller cancellation. Closing the store invalidates one
 * complete lifecycle generation; a later reusable generation starts cleanly.
 *
 * Despite the `Read` in these names the fence covers every managed store
 * operation — queries, constructs and updates alike. The names predate that
 * widening and are internal to this package; renaming them is a follow-up.
 */
export class ManagedReadRecoveryCoordinatorV1 {
  readonly #options: ManagedReadRecoveryCoordinatorOptionsV1;
  #lifecycleGeneration = 0;
  #pending?: {
    readonly timer: ReturnType<typeof setTimeout>;
    readonly deadline: number;
    readonly storeGeneration: number;
  };

  constructor(options: ManagedReadRecoveryCoordinatorOptionsV1) {
    this.#options = options;
  }

  begin(state: ManagedReadRecoveryStateV1 | null): ManagedReadRecoveryTokenV1 | null {
    if (this.#options.capability === undefined || state === null || state.recovering) return null;
    return Object.freeze({
      lifecycleGeneration: this.#lifecycleGeneration,
      storeGeneration: state.generation,
    });
  }

  retain(
    operation: StoreOperation,
    deadline: number,
    token: ManagedReadRecoveryTokenV1 | null,
  ): void {
    if (token === null || token.lifecycleGeneration !== this.#lifecycleGeneration) return;
    // Do not let a token captured before a completed restart replace the timer
    // for work admitted in the current server generation.
    const current = this.#readState();
    if (
      current === null
      || current.recovering
      || current.generation !== token.storeGeneration
    ) return;
    const pending = this.#pending;
    if (pending?.storeGeneration === token.storeGeneration && pending.deadline <= deadline) {
      return;
    }
    clearTimeout(pending?.timer);
    const timer = setTimeout(() => {
      if (this.#pending?.timer !== timer) return;
      const current = this.#readState();
      if (
        token.lifecycleGeneration === this.#lifecycleGeneration
        && current !== null
        && !current.recovering
        && current.generation === token.storeGeneration
      ) {
        try {
          this.#options.capability?.recover(operation);
        } catch {
          // Recovery notification must never escape a retained timer callback.
        }
      }
      if (this.#pending?.timer === timer) {
        this.#pending = undefined;
        this.#reportPending(false);
      }
    }, Math.max(0, deadline - this.#options.now()));
    timer.unref?.();
    this.#pending = { timer, deadline, storeGeneration: token.storeGeneration };
    if (pending === undefined) this.#reportPending(true);
  }

  close(): void {
    this.#lifecycleGeneration += 1;
    clearTimeout(this.#pending?.timer);
    const hadPending = this.#pending !== undefined;
    this.#pending = undefined;
    if (hadPending) this.#reportPending(false);
  }

  #reportPending(pending: boolean): void {
    try {
      this.#options.onPendingChange?.(pending);
    } catch {
      // Observation cannot alter retained recovery semantics.
    }
  }

  #readState(): ManagedReadRecoveryStateV1 | null {
    try {
      const state = this.#options.capability?.readState();
      if (
        typeof state?.recovering === 'boolean'
        && Number.isSafeInteger(state.generation)
        && state.generation >= 0
      ) return state;
    } catch {
      // A broken runtime capability must not replace the endpoint's result.
    }
    return null;
  }
}
