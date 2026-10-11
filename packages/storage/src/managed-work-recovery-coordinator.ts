// SPDX-License-Identifier: Apache-2.0

import type { ManagedOxigraphRecoveryHandleV1, ManagedOxigraphRuntimeStateV1 } from './managed-oxigraph-runtime-store.js';
import type { StoreOperation } from './store-operation-outcome.js';

export interface ManagedWorkRecoveryTokenV1 {
  readonly lifecycleGeneration: number;
  readonly storeGeneration: number;
}

export interface ManagedWorkRecoveryCapabilityV1 {
  readonly readState: () => ManagedOxigraphRuntimeStateV1 | null;
  readonly recover?: (operation: StoreOperation) => void;
  readonly requestRecovery?: (generation: number, operation: StoreOperation) => ManagedOxigraphRecoveryHandleV1 | undefined;
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
}

interface RetainedGeneration {
  readonly generation: number;
  readonly operations: Set<RetainedWork>;
  status:
    | { readonly phase: 'waiting'; retryAt: number }
    | { readonly phase: 'observing'; dispose?: () => void }
    | { readonly phase: 'stopped' };
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
  readonly #generations = new Map<number, RetainedGeneration>();
  #reportedPending = false;
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
    if (retention === null) {
      try { this.#options.capability?.recover?.(operation); } catch { /* Keep timeout compatibility. */ }
    }
    if (!this.#options.capability?.requestRecovery) this.#retireConfirmedGeneration(this.#readState());
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
    if (!this.#options.capability?.requestRecovery) this.#retireConfirmedGeneration(current);
    const read: RetainedWork = {
      operation,
      deadline,
    };
    let record = this.#generations.get(token.storeGeneration);
    if (!record) {
      record = { generation: token.storeGeneration, operations: new Set(), status: { phase: 'waiting', retryAt: 0 } };
      this.#generations.set(record.generation, record);
    }
    record.operations.add(read);
    // Preserve the fence before immediate timeout notification. Let that
    // attempt settle before retrying, keeping the original deadline intact.
    if (clientTimeout && record.status.phase === 'waiting') {
      record.status.retryAt = Math.max(record.status.retryAt, this.#options.now() + 1_000);
    }
    this.#reportPending();
    this.#arm();
    if (clientTimeout && this.#generations.get(record.generation) === record) this.#request(record, operation);
    const retainedGeneration = record;
    return {
      release: () => {
        if (this.#generations.get(retainedGeneration.generation) !== retainedGeneration
          || !retainedGeneration.operations.delete(read)) return;
        if (retainedGeneration.operations.size === 0) this.#retire(retainedGeneration);
        this.#arm();
        this.#reportPending();
      },
    };
  }

  close(): void {
    this.#lifecycleGeneration += 1;
    clearTimeout(this.#armed?.timer);
    this.#armed = undefined;
    for (const record of Array.from(this.#generations.values())) this.#retire(record);
    this.#reportPending();
  }

  #retire(record: RetainedGeneration): void {
    if (this.#generations.get(record.generation) !== record) return;
    this.#generations.delete(record.generation);
    if (record.status.phase === 'observing') record.status.dispose?.();
  }

  /** Point the single timer at the earliest outstanding read (or stop it). */
  #arm(): void {
    let earliest: { record: RetainedGeneration; read: RetainedWork; dueAt: number } | undefined;
    for (const record of this.#generations.values()) {
      if (record.status.phase !== 'waiting') continue;
      for (const read of record.operations) {
        const dueAt = Math.max(read.deadline, record.status.retryAt);
        if (earliest === undefined || dueAt < earliest.dueAt) earliest = { record, read, dueAt };
      }
    }
    if (this.#armed?.read === earliest?.read && this.#armed?.dueAt === earliest?.dueAt) return;
    clearTimeout(this.#armed?.timer);
    this.#armed = undefined;
    if (earliest === undefined) return;
    const { record, read, dueAt } = earliest;
    const timer = setTimeout(() => this.#expire(record, read), Math.max(0, dueAt - this.#options.now()));
    timer.unref?.();
    this.#armed = { timer, read, dueAt };
  }

  #expire(record: RetainedGeneration, read: RetainedWork): void {
    this.#armed = undefined;
    if (this.#options.capability?.requestRecovery) {
      if (record.operations.has(read)) this.#request(record, read.operation);
    } else {
      // Notification-only legacy capabilities cannot report physical completion.
      const current = this.#readState();
      this.#retireConfirmedGeneration(current);
      if (this.#generations.get(record.generation) === record && current !== null && !current.recovering
        && current.generation === record.generation) this.#request(record, read.operation);
      this.#retireConfirmedGeneration(this.#readState());
    }
    // A request can fail ownership verification or signalling. Only
    // supervisor reclamation (or legacy generation advancement) releases the fence;
    // retry at a bounded rate. Admission pause alone does not stop recovery:
    // maintenance itself may be draining this abandoned work. The supervisor
    // coalesces requests while ownership verification is already in progress.
    if (record.status.phase === 'waiting') record.status.retryAt = this.#options.now() + 1_000;
    this.#arm();
    this.#reportPending();
  }

  #request(record: RetainedGeneration, operation: StoreOperation): void {
    if (this.#generations.get(record.generation) !== record || record.status.phase !== 'waiting') return;
    const request = this.#options.capability?.requestRecovery;
    if (!request) {
      try { this.#options.capability?.recover?.(operation); } catch { /* Preserve caller result. */ }
      return;
    }
    let handle: ManagedOxigraphRecoveryHandleV1 | undefined;
    try { handle = request(record.generation, operation); } catch { /* Retry at the bounded deadline. */ }
    if (!handle || handle.generation !== record.generation || this.#generations.get(record.generation) !== record) return;
    const lifetime = this.#lifecycleGeneration;
    const observation: Extract<RetainedGeneration['status'], { phase: 'observing' }> = { phase: 'observing' };
    record.status = observation;
    let dispose: () => void;
    try { dispose = handle.subscribe(phase => {
      if (lifetime !== this.#lifecycleGeneration || this.#generations.get(record.generation) !== record
        || record.status !== observation) return;
      if (phase === 'terminated' || phase === 'reopened') {
        this.#retire(record);
      } else if (phase === 'cancelled' || phase === 'stopped') {
        record.status = phase === 'cancelled'
          ? { phase: 'waiting', retryAt: this.#options.now() + 1_000 } : { phase: 'stopped' };
        observation.dispose?.();
      } else return;
      this.#arm(); this.#reportPending();
    }); } catch {
      if (record.status === observation) record.status = { phase: 'waiting', retryAt: this.#options.now() + 1_000 };
      return;
    }
    // subscribe reports the current phase synchronously. A settled generation
    // must dispose this very subscription, not retain it after its notification.
    if (this.#generations.get(record.generation) === record && record.status === observation) observation.dispose = dispose;
    else dispose();
  }

  #retireConfirmedGeneration(current: ManagedOxigraphRuntimeStateV1 | null): void {
    for (const record of this.#generations.values()) {
      if (current !== null && current.generation !== record.generation) this.#retire(record);
    }
  }

  #reportPending(): void {
    const pending = this.#generations.size > 0;
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
