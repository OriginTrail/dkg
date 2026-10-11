// SPDX-License-Identifier: Apache-2.0

import type { ManagedOxigraphRuntimeStateV1 } from './managed-oxigraph-runtime-store.js';
import type { StoreOperation } from './store-operation-outcome.js';

export interface ManagedWorkRecoveryTokenV1 {
  readonly lifecycleGeneration: number;
  readonly storeGeneration: number;
}

export interface ManagedWorkRecoveryCapabilityV1 {
  readonly readState: () => ManagedOxigraphRuntimeStateV1;
  readonly recover: (operation: StoreOperation) => void;
}

export interface ManagedWorkRecoveryCoordinatorOptionsV1 {
  readonly now: () => number;
  readonly capability?: ManagedWorkRecoveryCapabilityV1;
  readonly onPendingChange?: (pending: boolean) => void;
}

/**
 * Handle for one retained work. Releasing it withdraws that read's claim on a
 * supervised restart, for a read whose server-side work is known to be over.
 */
export interface ManagedWorkRetentionV1 {
  readonly release: () => void;
}

interface RetainedWork {
  readonly operation: StoreOperation;
  readonly deadline: number;
  readonly lifecycleGeneration: number;
  readonly storeGeneration: number;
  physicallyTracked: boolean;
}

/**
 * Own the retained deadline for a managed operation whose HTTP request was
 * dispatched before the caller stopped waiting for it. Closing the store
 * invalidates one complete lifecycle generation; a later reusable generation
 * starts cleanly.
 *
 * Several operations can be retained at once. One timer serves the earliest
 * deadline, and releasing a read (its server work finished) re-arms the timer
 * for the earliest read that is still outstanding, so one read completing never
 * cancels the recovery another abandoned operation is owed.
 */
export class ManagedWorkRecoveryCoordinatorV1 {
  readonly #options: ManagedWorkRecoveryCoordinatorOptionsV1;
  #lifecycleGeneration = 0;
  readonly #retained = new Set<RetainedWork>();
  #reportedPending = false;
  #armed?: {
    readonly timer: ReturnType<typeof setTimeout>;
    readonly read: RetainedWork;
  };

  constructor(options: ManagedWorkRecoveryCoordinatorOptionsV1) {
    this.#options = options;
  }

  begin(state: ManagedOxigraphRuntimeStateV1 | null): ManagedWorkRecoveryTokenV1 | null {
    if (this.#options.capability === undefined || state === null || state.recovering) return null;
    return Object.freeze({
      lifecycleGeneration: this.#lifecycleGeneration,
      storeGeneration: state.generation,
    });
  }

  retain(
    operation: StoreOperation,
    deadline: number,
    token: ManagedWorkRecoveryTokenV1 | null,
    physicalWork?: Promise<unknown>,
  ): ManagedWorkRetentionV1 | null {
    if (token === null || token.lifecycleGeneration !== this.#lifecycleGeneration) return null;
    const current = this.#readState();
    if (
      current === null
      || current.recovering
      || current.generation !== token.storeGeneration
    ) {
      return null;
    }
    const read: RetainedWork = {
      operation,
      deadline,
      lifecycleGeneration: token.lifecycleGeneration,
      storeGeneration: token.storeGeneration,
      physicallyTracked: physicalWork !== undefined,
    };
    this.#retained.add(read);
    this.#reportPending();
    // The work lifecycle already counts a detached HTTP task. Only add a
    // server-work fence after that physical task settles without proof that
    // the server finished; otherwise one request would be counted twice.
    const physicalSettled = () => {
      if (!this.#retained.has(read)) return;
      read.physicallyTracked = false;
      this.#reportPending();
    };
    void physicalWork?.then(physicalSettled, physicalSettled);
    if (this.#armed === undefined || deadline < this.#armed.read.deadline) this.#arm();
    return {
      release: () => {
        if (!this.#retained.delete(read)) return;
        if (this.#armed?.read === read) this.#arm();
        this.#reportPending();
      },
    };
  }

  close(): void {
    this.#lifecycleGeneration += 1;
    clearTimeout(this.#armed?.timer);
    this.#armed = undefined;
    this.#retained.clear();
    this.#reportPending();
  }

  /** Point the single timer at the earliest outstanding read (or stop it). */
  #arm(): void {
    let earliest: RetainedWork | undefined;
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

  #expire(read: RetainedWork): void {
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
    this.#reportPending();
  }

  #reportPending(): void {
    const pending = [...this.#retained].some((work) => !work.physicallyTracked);
    if (pending === this.#reportedPending) return;
    this.#reportedPending = pending;
    try {
      this.#options.onPendingChange?.(pending);
    } catch {
      // Observation cannot alter recovery semantics.
    }
  }

  #readState(): ManagedOxigraphRuntimeStateV1 | null {
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
