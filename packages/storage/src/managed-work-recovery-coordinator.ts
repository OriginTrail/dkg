// SPDX-License-Identifier: Apache-2.0

import type { ManagedOxigraphRuntimeStateV1 } from './managed-oxigraph-runtime-store.js';
import type { StoreOperation } from './store-operation-outcome.js';

export interface ManagedWorkRecoveryTokenV1 {
  readonly lifecycleGeneration: number;
  readonly storeGeneration: number;
}

export interface ManagedWorkRecoveryCapabilityV1 {
  readonly readState: () => ManagedOxigraphRuntimeStateV1 | null;
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
  #retryAt = 0;
  #armed?: {
    readonly timer: ReturnType<typeof setTimeout>;
    readonly read: RetainedWork;
    readonly dueAt: number;
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
  ): ManagedWorkRetentionV1 | null {
    return this.#retain(operation, deadline, token, false);
  }

  /** Own immediate timeout notification and its retained recovery backstop. */
  clientTimedOut(
    operation: StoreOperation,
    deadline: number,
    token: ManagedWorkRecoveryTokenV1 | null,
  ): ManagedWorkRetentionV1 | null {
    const retention = this.#retain(operation, deadline, token, true);
    if (token !== null && retention === null) return null;
    try {
      this.#options.capability?.recover(operation);
    } catch {
      // Supervisor failure cannot replace the typed client timeout.
    }
    this.#retireConfirmedGeneration(this.#readState());
    this.#arm();
    this.#reportPending();
    return retention;
  }

  #retain(
    operation: StoreOperation,
    deadline: number,
    token: ManagedWorkRecoveryTokenV1 | null,
    clientTimeout: boolean,
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
    this.#retireConfirmedGeneration(current);
    const read: RetainedWork = {
      operation,
      deadline,
      lifecycleGeneration: token.lifecycleGeneration,
      storeGeneration: token.storeGeneration,
    };
    this.#retained.add(read);
    // Preserve the fence before immediate timeout notification. Let that
    // attempt settle before retrying, keeping the original deadline intact.
    if (clientTimeout) this.#retryAt = Math.max(this.#retryAt, this.#options.now() + 1_000);
    this.#reportPending();
    this.#arm();
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
    this.#retryAt = 0;
    this.#retained.clear();
    this.#reportPending();
  }

  /** Point the single timer at the earliest outstanding read (or stop it). */
  #arm(): void {
    let earliest: RetainedWork | undefined;
    for (const read of this.#retained) {
      if (earliest === undefined || read.deadline < earliest.deadline) earliest = read;
    }
    const dueAt = earliest === undefined ? 0 : Math.max(earliest.deadline, this.#retryAt);
    if (this.#armed?.read === earliest && this.#armed?.dueAt === dueAt) return;
    clearTimeout(this.#armed?.timer);
    this.#armed = undefined;
    if (earliest === undefined) { this.#retryAt = 0; return; }
    const read = earliest;
    const timer = setTimeout(() => this.#expire(read),
      Math.max(0, dueAt - this.#options.now()));
    timer.unref?.();
    this.#armed = { timer, read, dueAt };
  }

  #expire(read: RetainedWork): void {
    this.#armed = undefined;
    const current = this.#readState();
    this.#retireConfirmedGeneration(current);
    if (
      this.#retained.has(read)
      && read.lifecycleGeneration === this.#lifecycleGeneration
      && current !== null
      && !current.recovering
      && current.generation === read.storeGeneration
    ) {
      try {
        this.#options.capability?.recover(read.operation);
      } catch {
        // Recovery notification must never escape a retained timer callback.
      }
    }
    // A request can fail ownership verification or signalling. Only an
    // advanced generation proves reclamation; keep its activity fence and
    // retry at a bounded rate. Admission pause alone does not stop recovery:
    // maintenance itself may be draining this abandoned work. The supervisor
    // coalesces requests while ownership verification is already in progress.
    this.#retireConfirmedGeneration(this.#readState());
    this.#retryAt = this.#retained.has(read) ? this.#options.now() + 1_000 : 0;
    this.#arm();
    this.#reportPending();
  }

  #retireConfirmedGeneration(current: ManagedOxigraphRuntimeStateV1 | null): void {
    for (const work of this.#retained) {
      if (work.lifecycleGeneration !== this.#lifecycleGeneration
        || (current !== null && current.generation !== work.storeGeneration)) {
        this.#retained.delete(work);
      }
    }
    if (this.#retained.size === 0) this.#retryAt = 0;
  }

  #reportPending(): void {
    const pending = this.#retained.size > 0;
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
