// SPDX-License-Identifier: Apache-2.0
import type { AbortableStoreWorkLifecycle, StoreWorkContext } from '../abortable-store-work-lifecycle.js';
import type { ManagedOxigraphRecoveryHandleV1, ManagedOxigraphRuntimeStateV1 } from '../managed-oxigraph-runtime-store.js';
import type { ManagedWorkRecoveryCapabilityV1 } from '../managed-work-recovery-coordinator.js';
import { hasStoreOperationOutcome, type StoreOperation } from '../store-operation-outcome.js';
import type { QueryOptions } from '../triple-store.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDefinitiveSparqlUpdateRejectionV1, isSparqlHttpResponseError } from './sparql-http-response-error.js';
import { StoreOperationTimeoutError } from '../store-operation-timeout.js';

/** Execution evidence stays private to one adapter's asynchronous lifetime. */
interface LogicalMutationState {
  readonly storeGeneration: number | null;
  active: boolean;
  progress: 'not-dispatched' | 'dispatched' | 'acknowledged';
}

interface LogicalMutationOwner {
  readonly lifecycle: AbortableStoreWorkLifecycle;
  readonly readState: () => ManagedOxigraphRuntimeStateV1 | null;
  readonly backend: 'oxigraph-server' | 'sparql-http';
}

/** One store-bound scope; telemetry copies and other adapters cannot transfer it. */
export class SparqlHttpLogicalMutationScopeV1 {
  private readonly scope = new AsyncLocalStorage<LogicalMutationState>();
  constructor(private readonly owner: LogicalMutationOwner) {}

  private current(): LogicalMutationState | undefined {
    const state = this.scope.getStore();
    return state?.active ? state : undefined;
  }

  hasDispatchedMutation(): boolean {
    const state = this.current();
    return state !== undefined && state.progress !== 'not-dispatched';
  }

  markMutationDispatched(): void {
    const state = this.current();
    if (state?.progress === 'not-dispatched') state.progress = 'dispatched';
  }

  markMutationAcknowledged(): void {
    const state = this.current();
    if (state && state.progress !== 'not-dispatched') state.progress = 'acknowledged';
  }

  refusesAdmission(state: ManagedOxigraphRuntimeStateV1 | null): boolean {
    if (state === null) return false;
    const admission = this.current();
    return state.recovering
      || (admission?.storeGeneration != null && state.generation !== admission.storeGeneration)
      || (state.admissionsPaused === true && !this.hasDispatchedMutation());
  }

  run<T>(operation: StoreOperation, options: QueryOptions | undefined,
    work: (options: QueryOptions | undefined) => Promise<T>): Promise<T> {
    if (this.current()) return work(options);
    const state = this.owner.readState();
    if (this.refusesAdmission(state)) {
      return Promise.reject(new StoreOperationTimeoutError({ backend: this.owner.backend, operation, outcome: 'not_started' }));
    }
    return this.owner.lifecycle.run(options?.signal, signal => {
      const admission: LogicalMutationState = {
        storeGeneration: state?.generation ?? null, active: true, progress: 'not-dispatched',
      };
      return this.scope.run(admission, async () => {
        try { return await work({ ...options, signal }); }
        catch (cause) {
          if (!this.hasDispatchedMutation() || hasStoreOperationOutcome(cause, operation, 'indeterminate') || (
            admission.progress !== 'acknowledged' && isSparqlHttpResponseError(cause)
            && isDefinitiveSparqlUpdateRejectionV1(cause) && cause.operation === operation
          )) throw cause;
          throw new StoreOperationTimeoutError({ backend: this.owner.backend, operation, outcome: 'indeterminate',
            message: `${operation} outcome is indeterminate after mutation dispatch`, cause });
        } finally { admission.active = false; }
      });
    });
  }
}

/** Counted deletes share the adapter owner used by CAS and decorator bookkeeping. */
export function runSparqlHttpCountedDeleteV1(input: {
  readonly scope: SparqlHttpLogicalMutationScopeV1;
  readonly operation: 'deleteByPattern' | 'deleteBySubjectPrefix';
  readonly options: QueryOptions | undefined;
  readonly count: (options: QueryOptions) => Promise<number>;
  readonly mutate: (options: QueryOptions | undefined) => Promise<void>;
}): Promise<number> {
  return input.scope.run(input.operation, input.options, async options => {
    const count = (stage: string) => input.count({ ...options,
      source: options?.source ?? `sparql-http.${input.operation}.${stage}`,
    });
    const before = await count('countBefore');
    await input.mutate(options);
    return Math.max(0, before - await count('countAfter'));
  });
}

/**
 * What a caller's abort after dispatch does to the HTTP request of a read. It
 * is a required argument of {@link SparqlHttpStore.postQuery}, so no read path
 * gets one by omission.
 *
 * What the server does once its client has gone depends on the answer. A
 * streamed SELECT/CONSTRUCT stops when it next writes to the closed socket. A
 * blocking evaluation (an aggregate, an ORDER BY) sends nothing until it is
 * done and keeps evaluating, and once the fetch is aborted the client can no
 * longer see it finish. The policies below follow from that.
 *
 * - `cancel-on-abort`: the request runs on the caller's signal and is aborted
 *   with it. Used where the response consumer owns the body and stops reading
 *   it when the caller leaves: the RFC-64 shared-projection stream, whose
 *   spool is fed from the live body and cannot be drained-and-discarded.
 * - `detach-on-caller-abort`: the request is not cancelled by the caller; it
 *   runs on the store-close and client-deadline signals alone, under the
 *   lifecycle's drain contract (`work.runDetached`), while the caller is
 *   answered at once. From the first byte of the answer on, nothing is
 *   buffered for a caller who has left (see `relayAnswer`): what remains of the
 *   answer is read and discarded, but only up to
 *   {@link ABANDONED_READ_DRAIN_BUDGET_BYTES}. A short answer that ends inside
 *   that budget shows the server has finished; a longer one is streaming, so it
 *   is cancelled, and its recovery stays retained.
 *   Only honoured for a managed store with a recovery capability: only there
 *   does a still-running abandoned read have a supervised restart as its
 *   backstop. Anywhere else it behaves as `cancel-on-abort`, exactly as an
 *   unmanaged endpoint always did.
 */
export type SparqlHttpReadPolicy =
  | { readonly kind: 'cancel-on-abort' }
  | { readonly kind: 'detach-on-caller-abort'; readonly work: StoreWorkContext };

export const CANCEL_ON_ABORT: SparqlHttpReadPolicy = Object.freeze({ kind: 'cancel-on-abort' });

/**
 * How much of an answer is read, and thrown away, on behalf of a caller that
 * has left, to find out whether the server has finished with the request. It is
 * a hard bound on what an abandoned read costs the client once its caller is
 * gone: nothing is ever buffered for it, and a longer answer is cancelled
 * rather than read on (a streamed one would otherwise keep the server
 * producing, and the client reading, for the whole client deadline). It is
 * checked per chunk, so the client reads at most this much plus one chunk. 1 MiB
 * is a few thousand result rows: enough for every aggregate, ASK and small
 * SELECT to show a clean end, and about 30 ms of a streamed answer at the rate
 * Oxigraph 0.5 produces one (about 35 MB/s).
 */
export const ABANDONED_READ_DRAIN_BUDGET_BYTES = 1024 * 1024;

/**
 * Settle with `work`, or reject at once with the caller's abort reason while
 * `work` keeps running. `onAbandon` runs first, only when the abort wins.
 */
export function raceCallerAbandon<T>(
  work: Promise<T>,
  caller: AbortSignal,
  onAbandon: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      onAbandon();
      reject(caller.reason);
    };
    caller.addEventListener('abort', onAbort, { once: true });
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      caller.removeEventListener('abort', onAbort);
      settle();
    };
    work.then(
      (value) => finish(() => resolve(value)),
      (cause) => finish(() => reject(cause)),
    );
  });
}

export type SparqlHttpRecoveryState = ManagedOxigraphRuntimeStateV1;

/** Raw runtime inputs are normalized only at the managed store construction boundary. */
export interface ManagedSparqlRecoverySourceV1 {
  readonly readState: () => ManagedOxigraphRuntimeStateV1 | null;
  readonly recover?: (operation: StoreOperation) => void;
  readonly requestRecovery?: (generation: number, operation: StoreOperation) => ManagedOxigraphRecoveryHandleV1 | undefined;
}

/** Normalize compatibility once; the coordinator owns each returned handle directly. */
export function normalizeManagedSparqlRecoveryV1(
  source: ManagedSparqlRecoverySourceV1 | undefined,
): ManagedWorkRecoveryCapabilityV1 | undefined {
  if (source === undefined) return undefined;
  const read = source.readState;
  const recover = source.recover;
  const request = source.requestRecovery;
  const readState = () => {
    try {
      const state = read.call(source);
      if (typeof state?.recovering === 'boolean' && Number.isSafeInteger(state.generation) && state.generation >= 0) return state;
    } catch { /* An unreadable runtime cannot certify completion. */ }
    return null;
  };
  const notifyTimeout = (operation: StoreOperation) => {
    try { recover?.call(source, operation); } catch { /* Preserve the caller's timeout result. */ }
  };
  return Object.freeze({
    completion: request === undefined ? 'generation-change' : 'handle',
    readState,
    requestRecovery(generation: number | null, operation: StoreOperation) {
      if (generation === null) { notifyTimeout(operation); return undefined; }
      if (request !== undefined) return request.call(source, generation, operation);
      // Legacy input certifies completion only through an advanced generation;
      // no synthetic signalling/completion handle or observer registry is needed.
      const state = readState();
      if (state !== null && !state.recovering && state.generation === generation) notifyTimeout(operation);
      return undefined;
    },
  });
}

/** Compatibility shape for the runtime-only managed recovery capability. */
export interface SparqlHttpManagedRecoveryV1 {
  readonly readState: () => SparqlHttpRecoveryState;
  readonly recover: (operation: StoreOperation) => void;
}

export function snapshotManagedRecoveryCapability(
  input: SparqlHttpManagedRecoveryV1 | undefined,
): SparqlHttpManagedRecoveryV1 | undefined {
  if (input === undefined || input === null || typeof input !== 'object') return undefined;
  const readState = Object.getOwnPropertyDescriptor(input, 'readState');
  const recover = Object.getOwnPropertyDescriptor(input, 'recover');
  if (
    readState === undefined
    || recover === undefined
    || !Object.prototype.hasOwnProperty.call(readState, 'value')
    || !Object.prototype.hasOwnProperty.call(recover, 'value')
    || typeof readState.value !== 'function'
    || typeof recover.value !== 'function'
  ) return undefined;
  return Object.freeze({
    readState: readState.value as () => SparqlHttpRecoveryState,
    recover: recover.value as (operation: StoreOperation) => void,
  });
}
