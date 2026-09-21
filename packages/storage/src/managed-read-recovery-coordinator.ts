// SPDX-License-Identifier: Apache-2.0

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
  readonly recover: (operation: 'query' | 'construct') => void;
}

export interface ManagedReadRecoveryCoordinatorOptionsV1 {
  readonly now: () => number;
  readonly capability?: ManagedReadRecoveryCapabilityV1;
}

/**
 * Own the retained deadline for a managed read whose HTTP request was
 * dispatched before caller cancellation. Closing the store invalidates one
 * complete lifecycle generation; a later reusable generation starts cleanly.
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
    operation: 'query' | 'construct',
    deadline: number,
    token: ManagedReadRecoveryTokenV1 | null,
  ): void {
    if (token === null || token.lifecycleGeneration !== this.#lifecycleGeneration) return;
    const current = this.#readState();
    if (
      current === null
      || current.recovering
      || current.generation !== token.storeGeneration
    ) {
      return;
    }
    const pending = this.#pending;
    if (pending?.storeGeneration === token.storeGeneration && pending.deadline <= deadline) {
      return;
    }
    clearTimeout(pending?.timer);
    const timer = setTimeout(() => {
      if (this.#pending?.timer === timer) this.#pending = undefined;
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
    }, Math.max(0, deadline - this.#options.now()));
    timer.unref?.();
    this.#pending = { timer, deadline, storeGeneration: token.storeGeneration };
  }

  close(): void {
    this.#lifecycleGeneration += 1;
    clearTimeout(this.#pending?.timer);
    this.#pending = undefined;
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
