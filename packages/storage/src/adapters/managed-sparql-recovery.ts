// SPDX-License-Identifier: Apache-2.0
import type { AbortableStoreWorkLifecycle, StoreWorkContext } from '../abortable-store-work-lifecycle.js';
import type { ManagedOxigraphRuntimeStateV1 } from '../managed-oxigraph-runtime-store.js';
import type { StoreOperation } from '../store-operation-outcome.js';
import { findTripleStoreCapability, type QueryOptions } from '../triple-store.js';
import { isDefinitiveSparqlUpdateRejectionV1, isSparqlHttpResponseError } from './sparql-http-response-error.js';
import { StoreOperationTimeoutError } from '../store-operation-timeout.js';

/** Adapter-private continuation authority, never a public query option. */
export interface SparqlHttpOperationAdmissionV1 {
  readonly storeGeneration: number | null;
  dispatched: boolean;
  active?: boolean;
  mutationDispatched?: boolean;
  completedWrites?: number;
}

/** One backend owns the opaque continuation; ordinary option objects cannot mint it. */
interface LogicalMutationOwner {
  readonly lifecycle: AbortableStoreWorkLifecycle;
  readonly readState: () => ManagedOxigraphRuntimeStateV1 | null;
  readonly backend: 'oxigraph-server' | 'sparql-http';
}
const logicalOwners = new WeakMap<object, LogicalMutationOwner>();
const continuations = new WeakMap<object, { readonly store: object; readonly admission: SparqlHttpOperationAdmissionV1 }>();

/** @internal Installed by the adapter, not a serializable runtime/query option. */
export function registerSparqlHttpLogicalMutationOwnerV1(store: object, owner: LogicalMutationOwner): void {
  logicalOwners.set(store, owner);
}

export function sparqlHttpContinuationAdmissionV1(
  store: object, options: QueryOptions | undefined,
): SparqlHttpOperationAdmissionV1 | undefined {
  const continuation = options && continuations.get(options);
  return continuation?.store === store && continuation.admission.active === true ? continuation.admission : undefined;
}

/** Copy telemetry/options without losing a private, store-bound continuation. */
export function sparqlHttpContinuationOptionsV1(store: object, options: QueryOptions | undefined, updates: QueryOptions): QueryOptions {
  const copy = { ...options, ...updates };
  const admission = sparqlHttpContinuationAdmissionV1(store, options);
  if (admission) continuations.set(copy, { store, admission });
  return copy;
}

/** Keep activity and admission through both a mutation and its decorator bookkeeping. */
export function runSparqlHttpLogicalMutationV1<T>(
  store: unknown, operation: StoreOperation, options: QueryOptions | undefined,
  work: (options: QueryOptions | undefined) => Promise<T>,
): Promise<T> {
  const backend = findTripleStoreCapability(store, (candidate): candidate is object =>
    typeof candidate === 'object' && candidate !== null && logicalOwners.has(candidate));
  if (!backend) return work(options);
  const owner = logicalOwners.get(backend)!;
  if (sparqlHttpContinuationAdmissionV1(backend, options)) return work(options);
  const state = owner.readState();
  if (refusesSparqlHttpAdmissionV1(state)) {
    return Promise.reject(new StoreOperationTimeoutError({ backend: owner.backend, operation, outcome: 'not_started' }));
  }
  return owner.lifecycle.run(options?.signal, async signal => {
    const admission: SparqlHttpOperationAdmissionV1 = { storeGeneration: state?.generation ?? null, dispatched: false, active: true };
    const scoped = { ...options, signal };
    continuations.set(scoped, { store: backend, admission });
    try { return await work(scoped); }
    catch (cause) {
      if (!admission.mutationDispatched || (
        !admission.completedWrites && isSparqlHttpResponseError(cause) && isDefinitiveSparqlUpdateRejectionV1(cause)
        && cause.operation === operation
      )) throw cause;
      throw new StoreOperationTimeoutError({ backend: owner.backend, operation, outcome: 'indeterminate',
        message: `${operation} outcome is indeterminate after mutation dispatch`, cause });
    } finally {
      admission.active = false;
      continuations.delete(scoped);
    }
  });
}

/** Counted deletes use the same lifetime even without a changelog decorator. */
export function runSparqlHttpCountedDeleteV1(input: {
  readonly store: object;
  readonly operation: 'deleteByPattern' | 'deleteBySubjectPrefix';
  readonly options: QueryOptions | undefined;
  readonly count: (options: QueryOptions) => Promise<number>;
  readonly mutate: (options: QueryOptions | undefined) => Promise<void>;
}): Promise<number> {
  return runSparqlHttpLogicalMutationV1(input.store, input.operation, input.options, async options => {
    const count = (stage: string) => input.count(sparqlHttpContinuationOptionsV1(input.store, options, {
      source: options?.source ?? `sparql-http.${input.operation}.${stage}`,
    }));
    const before = await count('countBefore');
    await input.mutate(options);
    return Math.max(0, before - await count('countAfter'));
  });
}

export function refusesSparqlHttpAdmissionV1(
  state: ManagedOxigraphRuntimeStateV1 | null,
  admission?: SparqlHttpOperationAdmissionV1,
): boolean {
  if (state === null) return false;
  return state.recovering
    || (admission?.storeGeneration != null && state.generation !== admission.storeGeneration)
    || (state.admissionsPaused === true && admission?.dispatched !== true);
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
