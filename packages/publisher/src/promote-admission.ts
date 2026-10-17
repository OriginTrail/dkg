import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import { isStoreOperationTimeoutError, isStoreSchedulerBusyError, isStoreOperationNotStarted, type TripleStore } from '@origintrail-official/dkg-storage';
import { hasUnfinishedBoundObligation, storedPromoteLaneScope } from './async-promote-ownership.js';
import { PromoteJobConflictError, type PromoteJob, type PromoteRequest } from './async-promote-queue-types.js';
import { ACTIVE_PROMOTE_STATES, promoteLaneConflictScope, promoteLaneScopesConflict, uniquenessKey } from './async-promote-queue-utils.js';

export type PromoteAdmissionPhase = 'lock' | 'graph' | 'conflict' | 'persist';
export type PromoteAdmissionOutcome = 'not_admitted' | 'indeterminate';
export interface PromoteAdmissionEvent {
  event: 'phase_settled' | 'deadline';
  phase: PromoteAdmissionPhase;
  elapsedMs: number;
  outcome: 'completed' | PromoteAdmissionOutcome;
}

/** This verdict describes job admission, never every mutation in the HTTP request. */
export class PromoteAdmissionError extends Error {
  readonly code = 'PROMOTE_ADMISSION_UNAVAILABLE';
  readonly retryable = true;
  constructor(readonly phase: PromoteAdmissionPhase, readonly admissionOutcome: PromoteAdmissionOutcome,
    readonly jobId?: string, cause?: unknown) {
    super('Async share admission could not be confirmed', { cause });
    this.name = 'PromoteAdmissionError';
  }
}

const logger = new Logger('AsyncPromoteAdmission');
function trace(event: PromoteAdmissionEvent): void {
  if (process.env.DKG_ASYNC_PROMOTE_ADMISSION_TRACE === '1') {
    logger.info(createOperationContext('publish', 'admission'), `async_promote_admission ${JSON.stringify(event)}`);
  }
}

/** One bounded operation. Expiry before persist forbids a later admission write. */
export class PromoteAdmissionAttempt {
  phase: PromoteAdmissionPhase = 'lock';
  jobId?: string;
  private expired = false;
  private phaseStarted = performance.now();
  private readonly deadlineAt: number;
  constructor(timeoutMs: number, private readonly emit: (event: PromoteAdmissionEvent) => void) {
    this.deadlineAt = performance.now() + timeoutMs;
  }
  enter(phase: PromoteAdmissionPhase, jobId?: string): void {
    if (this.expired || performance.now() >= this.deadlineAt) throw this.expire();
    this.report('completed');
    this.phase = phase;
    this.jobId = jobId;
    this.phaseStarted = performance.now();
  }
  error(cause?: unknown): PromoteAdmissionError {
    return new PromoteAdmissionError(this.phase, this.jobId ? 'indeterminate' : 'not_admitted', this.jobId, cause);
  }
  persistFailed(cause: unknown): void {
    // Only at the primary persistence boundary, before flush: the canonical
    // atomic operation can prove it never dispatched. Nested query/flush
    // rejections cannot prove that no job was written.
    if (isStoreOperationNotStarted(cause, 'replaceSubject')) this.jobId = undefined;
  }
  expire(): PromoteAdmissionError { this.expired = true; return this.error(); }
  report(outcome: PromoteAdmissionEvent['outcome'], event: PromoteAdmissionEvent['event'] = 'phase_settled'): void {
    try { this.emit({ event, phase: this.phase, elapsedMs: Math.round(performance.now() - this.phaseStarted), outcome }); }
    catch { /* Observation cannot alter admission or release its integrity lock. */ }
  }
}

interface Flight { attempt: PromoteAdmissionAttempt; result: Promise<string>; }
interface Observation { jobId: string; scope: ReturnType<typeof storedPromoteLaneScope>; observedAt: number; }
const coordinators = new WeakMap<TripleStore, Map<string, PromoteAdmissionCoordinator>>();
const MAX_PENDING = 64;
const MAX_OBSERVATIONS = 1024;
const OBSERVATION_TTL_MS = 5 * 60_000;

/** Positive observations only: no cache entry ever authorizes a new admission. */
export class PromoteAdmissionCoordinator {
  private readonly pending = new Map<string, Flight>();
  private readonly owners = new Map<string, Observation>();

  static for(store: TripleStore, graph: string): PromoteAdmissionCoordinator {
    let graphs = coordinators.get(store);
    if (!graphs) { graphs = new Map(); coordinators.set(store, graphs); }
    let coordinator = graphs.get(graph);
    if (!coordinator) { coordinator = new PromoteAdmissionCoordinator(); graphs.set(graph, coordinator); }
    return coordinator;
  }

  invalidate(jobId: string): void { this.owners.delete(jobId); }
  /** Other activation paths cannot escape a pending async admission. */
  assertNoPending(request: PromoteRequest, excludeJobId?: string): void {
    const flight = this.pendingConflict(request, excludeJobId);
    if (flight) throw flight.attempt.error();
  }
  hasPending(request: PromoteRequest, excludeJobId?: string): boolean {
    return this.pendingConflict(request, excludeJobId) !== undefined;
  }
  private pendingConflict(request: PromoteRequest, excludeJobId?: string): Flight | undefined {
    const flight = this.pending.get(uniquenessKey(request));
    return flight && (!excludeJobId || flight.attempt.jobId !== excludeJobId) ? flight : undefined;
  }
  observe(job: PromoteJob): void {
    this.invalidate(job.jobId);
    // A fresh durable observation settles a retained ambiguous admission, even
    // when the worker has already completed it. Absence is NOT equivalent proof.
    for (const [key, flight] of this.pending) {
      if (flight.attempt.jobId === job.jobId) this.pending.delete(key);
    }
    if (!ACTIVE_PROMOTE_STATES.includes(job.state) && !hasUnfinishedBoundObligation(job)) return;
    if (this.owners.size >= MAX_OBSERVATIONS) this.owners.delete(this.owners.keys().next().value!);
    this.owners.set(job.jobId, { jobId: job.jobId, scope: storedPromoteLaneScope(job), observedAt: performance.now() });
  }

  async run(request: PromoteRequest, work: (attempt: PromoteAdmissionAttempt) => Promise<string>,
    timeoutMs: number, emit = trace): Promise<string> {
    const key = uniquenessKey(request);
    const existing = this.pending.get(key);
    if (existing) {
      if (existing.attempt.jobId) throw existing.attempt.error();
      // Share the original bounded attempt; never start a second admission to
      // escape uncertainty. Preserve the established conflict response on success.
      throw new PromoteJobConflictError(await existing.result, request);
    }
    const scope = promoteLaneConflictScope(request);
    for (const [id, owner] of this.owners) {
      if (performance.now() - owner.observedAt >= OBSERVATION_TTL_MS) { this.owners.delete(id); continue; }
      if (promoteLaneScopesConflict(owner.scope, scope)) throw new PromoteJobConflictError(id, request, true);
    }
    if (this.pending.size >= MAX_PENDING) throw new PromoteAdmissionError('lock', 'not_admitted');
    const attempt = new PromoteAdmissionAttempt(timeoutMs, emit);
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = attempt.expire();
        attempt.report(error.admissionOutcome, 'deadline');
        reject(error);
      }, timeoutMs);
    });
    // Start in a microtask so the entry exists before any observation can settle it.
    const operation = Promise.resolve().then(() => work(attempt)).catch(cause => {
      if (cause instanceof PromoteJobConflictError || cause instanceof PromoteAdmissionError) throw cause;
      if (attempt.jobId || isStoreSchedulerBusyError(cause) || isStoreOperationTimeoutError(cause)) throw attempt.error(cause);
      throw cause;
    });
    const result = Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
    const flight = { attempt, result };
    this.pending.set(key, flight);
    void operation.then(() => {
      attempt.report('completed');
      if (this.pending.get(key) === flight) this.pending.delete(key);
    }, error => {
      if (error instanceof PromoteAdmissionError) attempt.report(error.admissionOutcome);
      // A settled transport failure can still hide a committed write. Keep its
      // handle until durable observation; never blindly replay it with a new ID.
      if (!(error instanceof PromoteAdmissionError) || error.admissionOutcome === 'not_admitted') {
        if (this.pending.get(key) === flight) this.pending.delete(key);
      }
    });
    return result;
  }
}
