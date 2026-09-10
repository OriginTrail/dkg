// SPDX-License-Identifier: Apache-2.0

export interface ManagedReadRecoveryStateV1 {
  readonly recovering: boolean;
  readonly generation: number;
}

export interface ManagedReadRecoveryTokenV1 {
  readonly lifecycleGeneration: number;
  readonly storeGeneration: number;
}

export interface ManagedReadRecoveryCoordinatorOptionsV1 {
  readonly enabled: boolean;
  readonly now: () => number;
  readonly readRecoveryState: () => ManagedReadRecoveryStateV1 | null;
  readonly recover: (operation: 'query' | 'construct') => void;
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
    if (!this.#options.enabled || state === null || state.recovering) return null;
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
    const pending = this.#pending;
    if (pending?.storeGeneration === token.storeGeneration && pending.deadline <= deadline) {
      return;
    }
    clearTimeout(pending?.timer);
    const timer = setTimeout(() => {
      if (this.#pending?.timer === timer) this.#pending = undefined;
      const current = this.#options.readRecoveryState();
      if (
        token.lifecycleGeneration === this.#lifecycleGeneration
        && current !== null
        && !current.recovering
        && current.generation === token.storeGeneration
      ) {
        this.#options.recover(operation);
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
}
