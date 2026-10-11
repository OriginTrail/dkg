// SPDX-License-Identifier: Apache-2.0

import type { ManagedOxigraphRecoveryHandleV1, ManagedOxigraphRuntimeStateV1 } from './managed-oxigraph-runtime-store.js';
import type { StoreOperation } from './store-operation-outcome.js';

export interface ManagedWorkRecoveryTokenV1 {
  readonly lifecycleGeneration: number;
  readonly storeGeneration: number;
}

export interface ManagedWorkRecoveryCapabilityV1 {
  readonly completion: 'handle' | 'generation-change';
  readonly readState: () => ManagedOxigraphRuntimeStateV1 | null;
  /** A null generation only notifies an untracked client timeout; it cannot certify completion. */
  readonly requestRecovery: (generation: number | null, operation: StoreOperation) => ManagedOxigraphRecoveryHandleV1 | undefined;
}

export interface ManagedWorkRecoveryCoordinatorOptionsV1 {
  readonly now: () => number;
  readonly capability?: ManagedWorkRecoveryCapabilityV1;
  readonly retainActivity?: () => ManagedWorkRetentionV1;
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
    | { readonly phase: 'observing' }
    | { readonly phase: 'stopped' };
  activity?: ManagedWorkRetentionV1;
  observation?: { readonly handle: ManagedOxigraphRecoveryHandleV1; dispose?: () => void };
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
      try { this.#options.capability?.requestRecovery(null, operation); } catch { /* Keep timeout compatibility. */ }
    }
    this.#arm();
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
    const read: RetainedWork = {
      operation,
      deadline,
    };
    let record = this.#generations.get(token.storeGeneration);
    if (!record) {
      record = { generation: token.storeGeneration, operations: new Set(), status: { phase: 'waiting', retryAt: 0 },
        activity: this.#options.retainActivity?.() };
      this.#generations.set(record.generation, record);
    }
    record.operations.add(read);
    // Preserve the fence before immediate timeout notification. Let that
    // attempt settle before retrying, keeping the original deadline intact.
    if (clientTimeout && record.status.phase === 'waiting') {
      record.status.retryAt = Math.max(record.status.retryAt, this.#options.now() + 1_000);
    }
    this.#arm();
    if (clientTimeout && this.#generations.get(record.generation) === record) this.#request(record, operation);
    const retainedGeneration = record;
    return {
      release: () => {
        if (this.#generations.get(retainedGeneration.generation) !== retainedGeneration
          || !retainedGeneration.operations.delete(read)) return;
        if (retainedGeneration.operations.size === 0) this.#retire(retainedGeneration);
        this.#arm();
      },
    };
  }

  close(): void {
    this.#lifecycleGeneration += 1;
    clearTimeout(this.#armed?.timer);
    this.#armed = undefined;
    for (const record of Array.from(this.#generations.values())) this.#retire(record);
  }

  #retire(record: RetainedGeneration): void {
    if (this.#generations.get(record.generation) !== record) return;
    this.#generations.delete(record.generation);
    try { record.observation?.dispose?.(); } catch { /* Observation cannot prevent completion or reuse. */ }
    record.activity?.release();
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
    if (record.operations.has(read)) this.#request(record, read.operation);
    // A request can fail ownership verification or signalling. Only
    // confirmed completion releases the fence;
    // retry at a bounded rate. Admission pause alone does not stop recovery:
    // maintenance itself may be draining this abandoned work. The supervisor
    // coalesces requests while ownership verification is already in progress.
    if (record.status.phase === 'waiting') record.status.retryAt = this.#options.now() + 1_000;
    this.#arm();
  }

  #request(record: RetainedGeneration, operation: StoreOperation): void {
    if (this.#generations.get(record.generation) !== record || record.status.phase !== 'waiting') return;
    try {
      this.#readState();
      if (this.#generations.get(record.generation) !== record) return;
      const handle = this.#options.capability?.requestRecovery(record.generation, operation);
      this.#readState();
      if (handle === undefined || handle.generation !== record.generation
        || this.#generations.get(record.generation) !== record) return;
      this.#observeHandle(record, handle);
    } catch { /* Retry ownership verification or subscription at the bounded deadline. */ }
  }

  #observeHandle(record: RetainedGeneration, handle: ManagedOxigraphRecoveryHandleV1): void {
    try { record.observation?.dispose?.(); } catch { /* Observation cannot prevent completion or reuse. */ }
    const observation: NonNullable<RetainedGeneration['observation']> = { handle };
    record.observation = observation;
    const lifetime = this.#lifecycleGeneration;
    let dispose: () => void;
    try { dispose = handle.subscribe(phase => {
      if (lifetime !== this.#lifecycleGeneration || this.#generations.get(record.generation) !== record
        || record.observation !== observation) return;
      if (phase === 'terminated' || phase === 'reopened') {
        this.#retire(record);
      } else if (phase === 'cancelled' || phase === 'stopped') {
        record.observation = undefined;
        try { observation.dispose?.(); } catch { /* Cancellation still retains its activity fence. */ }
        record.status = phase === 'cancelled'
          ? { phase: 'waiting', retryAt: this.#options.now() + 1_000 } : { phase: 'stopped' };
      } else record.status = { phase: 'observing' };
      this.#arm();
    }); } catch {
      if (record.observation === observation) record.observation = undefined;
      record.status = { phase: 'waiting', retryAt: this.#options.now() + 1_000 };
      return;
    }
    // A synchronous completion/cancellation can retire the observation before subscribe returns.
    if (this.#generations.get(record.generation) === record && record.observation === observation) observation.dispose = dispose;
    else { try { dispose(); } catch { /* A synchronous terminal observation already settled ownership. */ } }
  }

  #readState(): ManagedOxigraphRuntimeStateV1 | null {
    try {
      const state = this.#options.capability?.readState();
      if (
        typeof state?.recovering === 'boolean'
        && Number.isSafeInteger(state.generation)
        && state.generation >= 0
      ) {
        if (this.#options.capability?.completion === 'generation-change') {
          for (const record of this.#generations.values()) {
            if (record.generation !== state.generation) this.#retire(record);
          }
        }
        return state;
      }
    } catch {
      // A broken runtime capability must not replace the endpoint's result.
    }
    return null;
  }
}
