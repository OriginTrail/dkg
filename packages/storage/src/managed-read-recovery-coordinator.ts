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
 * Handle for one retained read. Releasing it withdraws that read's claim on a
 * supervised restart, for a read whose server-side work is known to be over.
 */
export interface ManagedReadRetentionV1 {
  readonly release: () => void;
}

interface RetainedRead {
  readonly operation: 'query' | 'construct';
  readonly deadline: number;
  readonly lifecycleGeneration: number;
  readonly storeGeneration: number;
}

/**
 * Own the retained deadline for a managed read whose HTTP request was
 * dispatched before the caller stopped waiting for it. Closing the store
 * invalidates one complete lifecycle generation; a later reusable generation
 * starts cleanly.
 *
 * Several reads can be retained at once. One timer serves the earliest
 * deadline, and releasing a read (its server work finished) re-arms the timer
 * for the earliest read that is still outstanding, so one read completing never
 * cancels the recovery another abandoned read is owed.
 */
export class ManagedReadRecoveryCoordinatorV1 {
  readonly #options: ManagedReadRecoveryCoordinatorOptionsV1;
  #lifecycleGeneration = 0;
  readonly #retained = new Set<RetainedRead>();
  #armed?: {
    readonly timer: ReturnType<typeof setTimeout>;
    readonly read: RetainedRead;
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
  ): ManagedReadRetentionV1 | null {
    if (token === null || token.lifecycleGeneration !== this.#lifecycleGeneration) return null;
    const current = this.#readState();
    if (
      current === null
      || current.recovering
      || current.generation !== token.storeGeneration
    ) {
      return null;
    }
    const read: RetainedRead = {
      operation,
      deadline,
      lifecycleGeneration: token.lifecycleGeneration,
      storeGeneration: token.storeGeneration,
    };
    this.#retained.add(read);
    if (this.#armed === undefined || deadline < this.#armed.read.deadline) this.#arm();
    return {
      release: () => {
        if (this.#retained.delete(read) && this.#armed?.read === read) this.#arm();
      },
    };
  }

  close(): void {
    this.#lifecycleGeneration += 1;
    clearTimeout(this.#armed?.timer);
    this.#armed = undefined;
    this.#retained.clear();
  }

  /** Point the single timer at the earliest outstanding read (or stop it). */
  #arm(): void {
    let earliest: RetainedRead | undefined;
    for (const read of this.#retained) {
      if (earliest === undefined || read.deadline < earliest.deadline) earliest = read;
    }
    if (this.#armed?.read === earliest) return;
    clearTimeout(this.#armed?.timer);
    this.#armed = undefined;
    if (earliest === undefined) return;
    const read = earliest;
    const timer = setTimeout(() => this.#expire(read), Math.max(0, read.deadline - this.#options.now()));
    timer.unref?.();
    this.#armed = { timer, read };
  }

  #expire(read: RetainedRead): void {
    this.#armed = undefined;
    this.#retained.delete(read);
    const current = this.#readState();
    if (
      read.lifecycleGeneration === this.#lifecycleGeneration
      && current !== null
      && !current.recovering
      && current.generation === read.storeGeneration
    ) {
      // One supervised restart reclaims every read still running against this
      // store generation, so the others need no timer of their own.
      for (const other of this.#retained) {
        if (other.storeGeneration === read.storeGeneration) this.#retained.delete(other);
      }
      try {
        this.#options.capability?.recover(read.operation);
      } catch {
        // Recovery notification must never escape a retained timer callback.
      }
    }
    this.#arm();
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
