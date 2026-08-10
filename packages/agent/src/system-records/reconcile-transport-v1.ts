// SPDX-License-Identifier: Apache-2.0

import { Buffer } from 'node:buffer';

import {
  SYSTEM_RECORD_MAX_CLOSURE_BYTES,
  SYSTEM_RECORD_MAX_CLOSURE_OBJECTS,
  SYSTEM_RECORD_MAX_NEGATIVE_MEMO_ENTRIES,
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_MAX_PEER_ID_BYTES,
  SYSTEM_RECORD_MAX_SLICE_REQUESTS,
  SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
  SYSTEM_RECORD_NEGATIVE_MEMO_ENTRY_BASE_BYTES,
  SYSTEM_RECORD_NEGATIVE_MEMO_TTL_MS,
  SYSTEM_RECORD_SLICE_TIMEOUT_MS,
} from '@origintrail-official/dkg-core/system-record-v1';

import type {
  SystemRecordArtifactRepositoryV1,
  SystemRecordArtifactLookupV1,
  SystemRecordArtifactV1,
} from './artifact-v1.js';
import { systemRecordArtifactKeyV1 } from './artifact-v1.js';
import type {
  AgentProfileInventoryLoadRequestV1,
  AgentProfileInventoryLoadResultV1,
} from './reconcile-v1.js';
import type {
  SystemRecordExactArtifactLookupV1,
  SystemRecordExactFetchLeaseV1,
  SystemRecordExactFetchResultV1,
  SystemRecordRequesterByteAdmissionV1,
} from './requester-v1.js';
import {
  systemRecordExactLookupKeyV1,
  toSystemRecordExactArtifactLookupV1,
} from './requester-api-v1.js';

// Fixed control-state charges cover the handle/map entry itself. Requester leases
// continue to own and account the retained payload bytes without copying them.
const AGENT_PROFILE_RECONCILE_CONTINUATION_HANDLE_BYTES = 128;
const AGENT_PROFILE_RECONCILE_CONTINUATION_ENTRY_BASE_BYTES = 96;

export type AgentProfileReconcileNegativeFailureClassV1 =
  | 'timeout'
  | 'absence'
  | 'invalid';

export type AgentProfileReconcileTransportFailureV1 = Exclude<
  SystemRecordExactFetchResultV1,
  Readonly<{ outcome: 'ok' }>
>['outcome'];

export interface AgentProfileReconcileTransportSliceV1
  extends SystemRecordArtifactRepositoryV1 {
  /** Transfer one exact requester lease to the logical continuation owner. */
  takeExact(
    lookup: SystemRecordExactArtifactLookupV1,
    signal: AbortSignal,
  ): Promise<SystemRecordExactFetchLeaseV1 | null>;
  loadInventoryObject(
    request: AgentProfileInventoryLoadRequestV1,
    signal: AbortSignal,
  ): Promise<AgentProfileInventoryLoadResultV1>;
  stats(): AgentProfileReconcileTransportSliceStatsV1;
  release(): void;
}

export interface AgentProfileReconcileTransportSliceStatsV1 {
  readonly requests: number;
  readonly wireBytes: number;
}

export interface AgentProfileReconcileTransportStatsV1 {
  readonly activeSlice: 0 | 1;
  readonly requests: number;
  readonly wireBytes: number;
  readonly negativeMemoEntries: number;
  readonly negativeMemoBytes: number;
  readonly negativeMemoHits: number;
  readonly negativeMemoWrites: number;
  readonly negativeMemoEvictions: number;
  readonly retainedContinuationArtifacts: number;
  readonly retainedContinuationBytes: number;
  readonly retainedContinuationControlBytes: number;
  readonly closed: boolean;
}

export interface AgentProfileReconcileArtifactContinuationV1 {
  /** Bind one physical source while retaining exact objects across slice retries. */
  bind(source: AgentProfileReconcileTransportSliceV1): SystemRecordArtifactRepositoryV1;
  clear(): void;
  stats(): Readonly<{ artifacts: number; bytes: number; controlBytes: number }>;
  release(): void;
}

export interface AgentProfileReconcileTransportV1 {
  /** Opens one logical per-row retained-artifact continuation. */
  openArtifactContinuation(): AgentProfileReconcileArtifactContinuationV1 | null;
  /** Opens one nonqueued physical-slice view. */
  openSlice(input: Readonly<{
    signal: AbortSignal;
    deadlineMs: number;
    nowMs: () => number;
  }>): AgentProfileReconcileTransportSliceV1 | null;
  stats(): AgentProfileReconcileTransportStatsV1;
  close(): void;
}

export interface CreateAgentProfileReconcileTransportOptionsV1 {
  /** Returns an ordered bounded provider candidate set for each exact resolution. */
  readonly listProviderIds: () => readonly string[];
  /** Lifecycle transport binding for the selected provider and shared exact requester. */
  readonly fetchExact: (
    providerId: string,
    lookup: SystemRecordExactArtifactLookupV1,
    signal: AbortSignal,
  ) => Promise<SystemRecordExactFetchResultV1>;
  /** Existing aggregate control-state/accountant admission; never queues. */
  readonly controlAdmission: SystemRecordRequesterByteAdmissionV1;
  /** Test seams may lower, never raise, the frozen limits. */
  readonly negativeTtlMs?: number;
  readonly maxNegativeEntries?: number;
}

interface NegativeMemoEntryV1 {
  readonly providerId: string;
  readonly exactLookupKey: string;
  readonly failureClass: AgentProfileReconcileNegativeFailureClassV1;
  readonly failure: Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }>;
  readonly expiresAtMs: number;
  readonly bytes: number;
  readonly reservation: { release(): void };
}

interface AggregateExactFetchResultV1 {
  readonly result: SystemRecordExactFetchResultV1;
  /** All accountable bytes consumed across providers for this logical lookup. */
  readonly wireBytes: number;
}

export class AgentProfileReconcileTransportErrorV1 extends Error {
  readonly outcome: AgentProfileReconcileTransportFailureV1;
  readonly wireBytes: number;
  readonly retryable: boolean;

  constructor(outcome: AgentProfileReconcileTransportFailureV1, wireBytes: number) {
    super(`agent-profile exact transport failed: ${outcome}`);
    this.name = 'AgentProfileReconcileTransportErrorV1';
    this.outcome = outcome;
    this.wireBytes = wireBytes;
    this.retryable = exactFailurePolicy(outcome).retryableClosure;
  }
}

/**
 * Default-unused bridge from exact requester results into one reconciler slice.
 * It owns no timer, worker, waiter, retry queue, protocol, or lifecycle hook.
 */
export function createAgentProfileReconcileTransportV1(
  options: CreateAgentProfileReconcileTransportOptionsV1,
): AgentProfileReconcileTransportV1 {
  const listProviderIds = options.listProviderIds;
  const fetchExact = options.fetchExact;
  const controlAdmission = options.controlAdmission;
  const negativeTtlMs = boundedPositive(
    options.negativeTtlMs ?? SYSTEM_RECORD_NEGATIVE_MEMO_TTL_MS,
    SYSTEM_RECORD_NEGATIVE_MEMO_TTL_MS,
    'negativeTtlMs',
  );
  const maxNegativeEntries = boundedPositive(
    options.maxNegativeEntries ?? SYSTEM_RECORD_MAX_NEGATIVE_MEMO_ENTRIES,
    SYSTEM_RECORD_MAX_NEGATIVE_MEMO_ENTRIES,
    'maxNegativeEntries',
  );
  const negativeMemo = createNegativeMemoV1({
    controlAdmission,
    negativeTtlMs,
    maxNegativeEntries,
  });
  const artifactContinuations = new Set<AgentProfileReconcileArtifactContinuationV1>();
  let activeRelease: (() => void) | undefined;
  let activeSlice = false;
  let requests = 0;
  let wireBytes = 0;
  let closed = false;
  let lastNowMs = 0;

  return Object.freeze({ openArtifactContinuation, openSlice, stats, close });

  function openArtifactContinuation(): AgentProfileReconcileArtifactContinuationV1 | null {
    if (closed) return null;
    const handleReservation = controlAdmission.tryReserve(
      AGENT_PROFILE_RECONCILE_CONTINUATION_HANDLE_BYTES,
    );
    if (handleReservation === null) return null;
    const continuation = createArtifactContinuationV1({
      controlAdmission,
      handleReservation,
      onRelease: () => artifactContinuations.delete(continuation),
    });
    artifactContinuations.add(continuation);
    return continuation;
  }

  function openSlice(input: Readonly<{
    signal: AbortSignal;
    deadlineMs: number;
    nowMs: () => number;
  }>): AgentProfileReconcileTransportSliceV1 | null {
    const callerSignal = input.signal;
    const deadlineMs = input.deadlineMs;
    const nowMs = input.nowMs;
    callerSignal.throwIfAborted();
    if (closed || activeSlice) return null;
    const openedAtMs = readNow(nowMs);
    if (!Number.isSafeInteger(deadlineMs)
      || deadlineMs < openedAtMs
      || deadlineMs - openedAtMs > SYSTEM_RECORD_SLICE_TIMEOUT_MS) {
      throw new Error('agent-profile transport slice deadline is outside its physical bound');
    }
    activeSlice = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([callerSignal, controller.signal]);
    const leases: SystemRecordExactFetchLeaseV1[] = [];
    const budget = createSliceBudgetV1({
      onRequest: () => { requests += 1; },
      onWireBytes: (bytes) => { wireBytes += bytes; },
    });
    let released = false;

    const slice: AgentProfileReconcileTransportSliceV1 = Object.freeze({
      async resolve(
        lookup: SystemRecordArtifactLookupV1,
        callerSignal: AbortSignal,
      ): Promise<SystemRecordArtifactV1 | null> {
        const exactLookup = toSystemRecordExactArtifactLookupV1(lookup);
        if (exactLookup === null) {
          throw new Error(lookup.type === 'root'
            ? 'agent-profile reconcile transport requires an exact artifact'
            : 'agent-profile reconcile transport requires exact inventory coordinates');
        }
        const fetched = await resolveExact(exactLookup, callerSignal);
        if (fetched.result.outcome === 'ok') return fetched.result.lease.artifact;
        if (fetched.result.outcome === 'not-found'
            || fetched.result.outcome === 'unsupported') return null;
        throw new AgentProfileReconcileTransportErrorV1(
          fetched.result.outcome,
          fetched.wireBytes,
        );
      },
      async takeExact(
        lookup: SystemRecordExactArtifactLookupV1,
        callerSignal: AbortSignal,
      ): Promise<SystemRecordExactFetchLeaseV1 | null> {
        const fetched = await resolveExact(lookup, callerSignal);
        if (fetched.result.outcome === 'ok') {
          const lease = fetched.result.lease;
          const ownedIndex = leases.lastIndexOf(lease);
          if (ownedIndex < 0) {
            lease.release();
            throw new Error('agent-profile transport lost exact lease ownership');
          }
          leases.splice(ownedIndex, 1);
          return lease;
        }
        if (fetched.result.outcome === 'not-found'
            || fetched.result.outcome === 'unsupported') return null;
        throw new AgentProfileReconcileTransportErrorV1(
          fetched.result.outcome,
          fetched.wireBytes,
        );
      },
      async loadInventoryObject(
        request: AgentProfileInventoryLoadRequestV1,
        callerSignal: AbortSignal,
      ): Promise<AgentProfileInventoryLoadResultV1> {
        const fetched = await resolveExact(Object.freeze({
          type: 'inventory-object',
          rootDescriptorDigest: request.rootDescriptorDigest,
          path: Object.freeze([...request.path]),
          objectKind: request.expectedKind,
          objectDigest: request.objectDigest,
        }), callerSignal);
        if (fetched.result.outcome === 'ok') {
          return Object.freeze({
            outcome: 'ok',
            objectKind: fetched.result.lease.artifact.objectKind as typeof request.expectedKind,
            canonicalBytes: fetched.result.lease.artifact.canonicalBytes,
            wireBytes: fetched.wireBytes,
          });
        }
        return Object.freeze({
          outcome: 'rejected',
          wireBytes: fetched.wireBytes,
          rejection: exactFailurePolicy(fetched.result.outcome).inventoryRejection,
        });
      },
      stats: budget.stats,
      release,
    });
    activeRelease = release;
    return slice;

    async function resolveExact(
      lookup: SystemRecordExactArtifactLookupV1,
      callerSignal: AbortSignal,
    ): Promise<AggregateExactFetchResultV1> {
      if (released || closed) return aggregateFailure('closed', 0);
      callerSignal.throwIfAborted();
      signal.throwIfAborted();
      const providers = providerSnapshot(
        listProviderIds(),
        maxNegativeEntries + SYSTEM_RECORD_MAX_SLICE_REQUESTS,
      );
      const exactLookupKey = systemRecordExactLookupKeyV1(lookup);
      let selectedFailure: Exclude<
        SystemRecordExactFetchResultV1,
        { outcome: 'ok' }
      > | undefined;
      let lookupWireBytes = 0;
      for (const providerId of providers) {
        const now = readNow(nowMs);
        negativeMemo.prune(now);
        if (now >= deadlineMs || signal.aborted || callerSignal.aborted) {
          signal.throwIfAborted();
          callerSignal.throwIfAborted();
          return aggregateFailure('deadline', lookupWireBytes);
        }
        const cachedFailure = negativeMemo.get(providerId, exactLookupKey, now);
        if (cachedFailure !== undefined) {
          selectedFailure = selectFailure(selectedFailure, cachedFailure);
          continue;
        }
        if (!budget.canAttempt()) {
          return aggregateFailure('capacity', lookupWireBytes);
        }
        budget.beginAttempt();
        const attemptSignal = AbortSignal.any([signal, callerSignal]);
        const attempt = normalizeExactAttemptV1(
          await fetchExact(providerId, lookup, attemptSignal),
          lookup,
        );
        const completedAt = readNow(nowMs);
        const accountedWireBytes = attempt.wireBytes;
        if (accountedWireBytes !== null) lookupWireBytes += accountedWireBytes;
        budget.accountWireBytes(accountedWireBytes);
        if (released || closed || signal.aborted || callerSignal.aborted) {
          attempt.releaseRejectedLease();
          signal.throwIfAborted();
          callerSignal.throwIfAborted();
          return aggregateFailure('closed', lookupWireBytes);
        }
        if (accountedWireBytes === null) {
          if (attempt.outcome !== 'failure') {
            throw new Error('successful exact attempt omitted its accounted wire bytes');
          }
          attempt.releaseRejectedLease();
          selectedFailure = selectFailure(selectedFailure, attempt.failure);
          negativeMemo.remember(providerId, exactLookupKey, attempt.failure, completedAt);
          continue;
        }
        if (attempt.memoInvalidBeforeSliceCapacity) {
          if (attempt.outcome !== 'failure') {
            throw new Error('invalid exact attempt did not expose its failure');
          }
          negativeMemo.remember(providerId, exactLookupKey, attempt.failure, completedAt);
        }
        if (budget.exceedsWireLimit()) {
          attempt.releaseRejectedLease();
          return aggregateFailure('capacity', lookupWireBytes);
        }
        if (completedAt >= deadlineMs) {
          attempt.releaseRejectedLease();
          negativeMemo.remember(
            providerId,
            exactLookupKey,
            Object.freeze({ outcome: 'deadline', wireBytes: 0 }),
            completedAt,
          );
          return aggregateFailure('deadline', lookupWireBytes);
        }
        if (attempt.outcome === 'success') {
          leases.push(attempt.result.lease);
          return Object.freeze({ result: attempt.result, wireBytes: lookupWireBytes });
        }
        attempt.releaseRejectedLease();
        selectedFailure = selectFailure(selectedFailure, attempt.failure);
        if (exactFailurePolicy(attempt.failure.outcome).memoClass !== null
            && !attempt.memoInvalidBeforeSliceCapacity) {
          negativeMemo.remember(providerId, exactLookupKey, attempt.failure, completedAt);
        }
      }
      const result = selectedFailure
        ?? Object.freeze({ outcome: 'busy' as const, wireBytes: 0 });
      return Object.freeze({ result, wireBytes: lookupWireBytes });
    }

    function release(): void {
      if (released) return;
      released = true;
      controller.abort(new Error('agent-profile reconcile transport slice released'));
      for (const lease of leases.splice(0)) lease.release();
      if (activeRelease === release) activeRelease = undefined;
      activeSlice = false;
    }
  }

  function stats(): AgentProfileReconcileTransportStatsV1 {
    const memoStats = negativeMemo.stats();
    let retainedContinuationArtifacts = 0;
    let retainedContinuationBytes = 0;
    let retainedContinuationControlBytes = 0;
    for (const continuation of artifactContinuations) {
      const retained = continuation.stats();
      retainedContinuationArtifacts += retained.artifacts;
      retainedContinuationBytes += retained.bytes;
      retainedContinuationControlBytes += retained.controlBytes;
    }
    return Object.freeze({
      activeSlice: activeSlice ? 1 : 0,
      requests,
      wireBytes,
      ...memoStats,
      retainedContinuationArtifacts,
      retainedContinuationBytes,
      retainedContinuationControlBytes,
      closed,
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    activeRelease?.();
    for (const continuation of [...artifactContinuations]) continuation.release();
    negativeMemo.close();
  }

  function readNow(nowMs: () => number): number {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < lastNowMs) {
      throw new Error('agent-profile reconcile transport clock is not monotonic');
    }
    lastNowMs = value;
    return value;
  }
}

interface RetainedContinuationArtifactV1 {
  readonly lease: SystemRecordExactFetchLeaseV1;
  readonly bytes: number;
  readonly metadataReservation: { release(): void };
}

function createArtifactContinuationV1(options: Readonly<{
  controlAdmission: SystemRecordRequesterByteAdmissionV1;
  handleReservation: { release(): void };
  onRelease(): void;
}>): AgentProfileReconcileArtifactContinuationV1 {
  const retained = new Map<string, RetainedContinuationArtifactV1>();
  let retainedBytes = 0;
  let retainedControlBytes = AGENT_PROFILE_RECONCILE_CONTINUATION_HANDLE_BYTES;
  let generation = 0;
  let released = false;
  return Object.freeze({ bind, clear, stats, release });

  function bind(source: AgentProfileReconcileTransportSliceV1): SystemRecordArtifactRepositoryV1 {
    if (released) throw new Error('agent-profile artifact continuation is released');
    return Object.freeze({
      async resolve(
        lookup: SystemRecordArtifactLookupV1,
        signal: AbortSignal,
      ): Promise<SystemRecordArtifactV1 | null> {
        if (released) throw new Error('agent-profile artifact continuation is released');
        if (lookup.type !== 'object') {
          throw new Error('agent-profile closure continuation requires an exact object lookup');
        }
        signal.throwIfAborted();
        const key = systemRecordArtifactKeyV1({
          objectKind: lookup.objectKind,
          objectDigest: lookup.objectDigest,
        });
        const cached = retained.get(key);
        if (cached !== undefined) return cached.lease.artifact;
        const fetchGeneration = generation;
        const exactLookup = toSystemRecordExactArtifactLookupV1(lookup);
        if (exactLookup === null || exactLookup.type !== 'object') {
          throw new Error('agent-profile closure continuation requires a control artifact');
        }
        const lease = await source.takeExact(exactLookup, signal);
        if (lease === null) return null;
        if (released || generation !== fetchGeneration || signal.aborted) {
          lease.release();
          if (released || generation !== fetchGeneration) {
            throw new AgentProfileReconcileTransportErrorV1('closed', 0);
          }
          signal.throwIfAborted();
        }
        const artifact = lease.artifact;
        if (artifact.objectKind !== lookup.objectKind
            || artifact.objectDigest !== lookup.objectDigest) {
          lease.release();
          throw new Error('agent-profile continuation source returned a different artifact');
        }
        const concurrentlyRetained = retained.get(key);
        if (concurrentlyRetained !== undefined) {
          lease.release();
          return concurrentlyRetained.lease.artifact;
        }
        const payloadBytes = artifact.canonicalBytes.byteLength;
        if (retained.size >= SYSTEM_RECORD_MAX_CLOSURE_OBJECTS
            || retainedBytes + payloadBytes > SYSTEM_RECORD_MAX_CLOSURE_BYTES) {
          lease.release();
          throw new Error('agent-profile closure continuation exceeds its retained bound');
        }
        const accountedBytes = AGENT_PROFILE_RECONCILE_CONTINUATION_ENTRY_BASE_BYTES
          + Buffer.byteLength(key, 'utf8');
        const metadataReservation = options.controlAdmission.tryReserve(accountedBytes);
        if (metadataReservation === null) {
          lease.release();
          throw new AgentProfileReconcileTransportErrorV1('capacity', 0);
        }
        retained.set(key, Object.freeze({ lease, bytes: payloadBytes, metadataReservation }));
        retainedBytes += payloadBytes;
        retainedControlBytes += accountedBytes;
        return artifact;
      },
    });
  }

  function clear(): void {
    generation += 1;
    for (const entry of retained.values()) {
      entry.lease.release();
      entry.metadataReservation.release();
    }
    retained.clear();
    retainedBytes = 0;
    retainedControlBytes = released ? 0 : AGENT_PROFILE_RECONCILE_CONTINUATION_HANDLE_BYTES;
  }

  function stats(): Readonly<{ artifacts: number; bytes: number; controlBytes: number }> {
    return Object.freeze({
      artifacts: retained.size,
      bytes: retainedBytes,
      controlBytes: retainedControlBytes,
    });
  }

  function release(): void {
    if (released) return;
    released = true;
    clear();
    options.handleReservation.release();
    options.onRelease();
  }
}

function aggregateFailure(
  outcome: AgentProfileReconcileTransportFailureV1,
  wireBytes: number,
): AggregateExactFetchResultV1 {
  return Object.freeze({
    result: Object.freeze({ outcome, wireBytes }),
    wireBytes,
  });
}

interface SliceBudgetV1 {
  canAttempt(): boolean;
  beginAttempt(): void;
  accountWireBytes(bytes: number | null): void;
  exceedsWireLimit(): boolean;
  stats(): AgentProfileReconcileTransportSliceStatsV1;
}

function createSliceBudgetV1(options: Readonly<{
  onRequest(): void;
  onWireBytes(bytes: number): void;
}>): SliceBudgetV1 {
  let requests = 0;
  let wireBytes = 0;
  return Object.freeze({
    canAttempt: () => requests < SYSTEM_RECORD_MAX_SLICE_REQUESTS
      && wireBytes < SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
    beginAttempt() {
      requests += 1;
      options.onRequest();
    },
    accountWireBytes(bytes: number | null) {
      if (bytes === null) return;
      wireBytes += bytes;
      options.onWireBytes(bytes);
    },
    exceedsWireLimit: () => wireBytes > SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
    stats: () => Object.freeze({ requests, wireBytes }),
  });
}

interface NegativeMemoV1 {
  get(
    providerId: string,
    exactLookupKey: string,
    now: number,
  ): Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }> | undefined;
  remember(
    providerId: string,
    exactLookupKey: string,
    failure: Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }>,
    observedAtMs: number,
  ): void;
  prune(now: number): void;
  stats(): Pick<
    AgentProfileReconcileTransportStatsV1,
    | 'negativeMemoEntries'
    | 'negativeMemoBytes'
    | 'negativeMemoHits'
    | 'negativeMemoWrites'
    | 'negativeMemoEvictions'
  >;
  close(): void;
}

function createNegativeMemoV1(options: Readonly<{
  controlAdmission: SystemRecordRequesterByteAdmissionV1;
  negativeTtlMs: number;
  maxNegativeEntries: number;
}>): NegativeMemoV1 {
  const entries = new Map<string, NegativeMemoEntryV1>();
  let bytes = 0;
  let hits = 0;
  let writes = 0;
  let evictions = 0;
  let closed = false;
  return Object.freeze({ get, remember, prune, stats, close });

  function get(
    providerId: string,
    exactLookupKey: string,
    now: number,
  ): Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }> | undefined {
    const entry = entries.get(memoKey(providerId, exactLookupKey));
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= now) {
      remove(entry, false);
      return undefined;
    }
    hits += 1;
    return Object.freeze({ outcome: entry.failure.outcome, wireBytes: 0 });
  }

  function remember(
    providerId: string,
    exactLookupKey: string,
    failure: Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }>,
    observedAtMs: number,
  ): void {
    if (closed) return;
    prune(observedAtMs);
    const failureClass = exactFailurePolicy(failure.outcome).memoClass;
    if (failureClass === null) return;
    const key = memoKey(providerId, exactLookupKey);
    const expiresAtMs = observedAtMs + options.negativeTtlMs;
    if (!Number.isSafeInteger(expiresAtMs)) return;
    const existing = entries.get(key);
    if (existing !== undefined) {
      entries.delete(key);
      entries.set(key, Object.freeze({
        ...existing,
        failureClass,
        failure: snapshotNegativeFailure(failure),
        expiresAtMs,
      }));
      writes += 1;
      return;
    }
    while (entries.size >= options.maxNegativeEntries) {
      let oldest: NegativeMemoEntryV1 | undefined;
      for (const candidate of entries.values()) {
        oldest = candidate;
        break;
      }
      if (oldest === undefined) break;
      remove(oldest, true);
    }
    const entryBytes = SYSTEM_RECORD_NEGATIVE_MEMO_ENTRY_BASE_BYTES
      + Buffer.byteLength(key, 'utf8');
    const reservation = options.controlAdmission.tryReserve(entryBytes);
    if (reservation === null) return;
    const entry = Object.freeze({
      providerId,
      exactLookupKey,
      failureClass,
      failure: snapshotNegativeFailure(failure),
      expiresAtMs,
      bytes: entryBytes,
      reservation,
    });
    entries.set(key, entry);
    bytes += entryBytes;
    writes += 1;
  }

  function prune(now: number): void {
    for (const entry of entries.values()) {
      if (entry.expiresAtMs <= now) remove(entry, false);
    }
  }

  function remove(entry: NegativeMemoEntryV1, evicted: boolean): void {
    const key = memoKey(entry.providerId, entry.exactLookupKey);
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    bytes -= entry.bytes;
    entry.reservation.release();
    if (evicted) evictions += 1;
  }

  function stats(): ReturnType<NegativeMemoV1['stats']> {
    return Object.freeze({
      negativeMemoEntries: entries.size,
      negativeMemoBytes: bytes,
      negativeMemoHits: hits,
      negativeMemoWrites: writes,
      negativeMemoEvictions: evictions,
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    for (const entry of [...entries.values()]) remove(entry, false);
  }
}

function providerSnapshot(input: readonly string[], maximum: number): readonly string[] {
  const seen = new Set<string>();
  const providers: string[] = [];
  for (const value of input) {
    if (typeof value !== 'string'
      || value.length === 0
      || Buffer.byteLength(value, 'utf8') > SYSTEM_RECORD_MAX_PEER_ID_BYTES) {
      throw new TypeError('agent-profile provider id is invalid');
    }
    if (seen.has(value)) continue;
    seen.add(value);
    providers.push(value);
    if (providers.length === maximum) break;
  }
  return Object.freeze(providers);
}

type NormalizedExactAttemptV1 =
  | Readonly<{
      outcome: 'success';
      result: Extract<SystemRecordExactFetchResultV1, { outcome: 'ok' }>;
      wireBytes: number;
      memoInvalidBeforeSliceCapacity: false;
      releaseRejectedLease(): void;
    }>
  | Readonly<{
      outcome: 'failure';
      failure: Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }>;
      /** Null means the requester returned an unaccountable byte count. */
      wireBytes: number | null;
      memoInvalidBeforeSliceCapacity: boolean;
      releaseRejectedLease(): void;
    }>;

/** Normalize one provider result before the outer loop applies slice policy. */
function normalizeExactAttemptV1(
  result: SystemRecordExactFetchResultV1,
  lookup: SystemRecordExactArtifactLookupV1,
): NormalizedExactAttemptV1 {
  const reportedWireBytes = result.outcome === 'ok'
    ? result.lease.wireBytes
    : result.wireBytes;
  let released = false;
  const releaseRejectedLease = () => {
    if (released || result.outcome !== 'ok') return;
    released = true;
    result.lease.release();
  };
  if (!Number.isSafeInteger(reportedWireBytes) || reportedWireBytes < 0) {
    return Object.freeze({
      outcome: 'failure',
      failure: Object.freeze({ outcome: 'invalid-response', wireBytes: 0 }),
      wireBytes: null,
      memoInvalidBeforeSliceCapacity: false,
      releaseRejectedLease,
    });
  }
  if (reportedWireBytes > SYSTEM_RECORD_MAX_FRAME_BYTES) {
    return Object.freeze({
      outcome: 'failure',
      failure: Object.freeze({ outcome: 'invalid-response', wireBytes: reportedWireBytes }),
      wireBytes: reportedWireBytes,
      memoInvalidBeforeSliceCapacity: true,
      releaseRejectedLease,
    });
  }
  if (result.outcome !== 'ok') {
    return Object.freeze({
      outcome: 'failure',
      failure: result,
      wireBytes: reportedWireBytes,
      memoInvalidBeforeSliceCapacity: false,
      releaseRejectedLease,
    });
  }
  if (result.lease.artifact.objectKind !== lookup.objectKind
      || result.lease.artifact.objectDigest !== lookup.objectDigest
      || !(result.lease.artifact.canonicalBytes instanceof Uint8Array)) {
    return Object.freeze({
      outcome: 'failure',
      failure: Object.freeze({ outcome: 'invalid-response', wireBytes: reportedWireBytes }),
      wireBytes: reportedWireBytes,
      memoInvalidBeforeSliceCapacity: false,
      releaseRejectedLease,
    });
  }
  return Object.freeze({
    outcome: 'success',
    result,
    wireBytes: reportedWireBytes,
    memoInvalidBeforeSliceCapacity: false,
    releaseRejectedLease,
  });
}

interface ExactFailurePolicyV1 {
  readonly rank: number;
  readonly memoClass: AgentProfileReconcileNegativeFailureClassV1 | null;
  readonly inventoryRejection: 'not-found' | 'invalid-response' | 'busy' | 'transport';
  readonly retryableClosure: boolean;
}

const EXACT_FAILURE_POLICY_V1 = Object.freeze({
  'invalid-response': Object.freeze({
    rank: 5,
    memoClass: 'invalid',
    inventoryRejection: 'invalid-response',
    retryableClosure: false,
  }),
  deadline: Object.freeze({
    rank: 4,
    memoClass: 'timeout',
    inventoryRejection: 'transport',
    retryableClosure: true,
  }),
  transport: Object.freeze({
    rank: 3,
    memoClass: null,
    inventoryRejection: 'transport',
    retryableClosure: true,
  }),
  'remote-error': Object.freeze({
    rank: 3,
    memoClass: null,
    inventoryRejection: 'transport',
    retryableClosure: true,
  }),
  'remote-busy': Object.freeze({
    rank: 2,
    memoClass: null,
    inventoryRejection: 'busy',
    retryableClosure: true,
  }),
  busy: Object.freeze({
    rank: 2,
    memoClass: null,
    inventoryRejection: 'busy',
    retryableClosure: true,
  }),
  capacity: Object.freeze({
    rank: 2,
    memoClass: null,
    inventoryRejection: 'busy',
    retryableClosure: true,
  }),
  'waiter-limit': Object.freeze({
    rank: 2,
    memoClass: null,
    inventoryRejection: 'busy',
    retryableClosure: true,
  }),
  closed: Object.freeze({
    rank: 2,
    memoClass: null,
    inventoryRejection: 'transport',
    retryableClosure: true,
  }),
  'not-found': Object.freeze({
    rank: 1,
    memoClass: 'absence',
    inventoryRejection: 'not-found',
    retryableClosure: false,
  }),
  unsupported: Object.freeze({
    rank: 1,
    memoClass: 'absence',
    inventoryRejection: 'not-found',
    retryableClosure: false,
  }),
} satisfies Readonly<Record<AgentProfileReconcileTransportFailureV1, ExactFailurePolicyV1>>);

function exactFailurePolicy(
  outcome: AgentProfileReconcileTransportFailureV1,
): ExactFailurePolicyV1 {
  return EXACT_FAILURE_POLICY_V1[outcome];
}

function selectFailure(
  current: Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }> | undefined,
  candidate: Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }>,
): Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }> {
  if (current === undefined) return candidate;
  return exactFailurePolicy(candidate.outcome).rank > exactFailurePolicy(current.outcome).rank
    ? candidate
    : current;
}

function memoKey(
  providerId: string,
  exactLookupKey: string,
): string {
  return JSON.stringify([providerId, exactLookupKey]);
}

function snapshotNegativeFailure(
  failure: Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }>,
): Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }> {
  return Object.freeze({ outcome: failure.outcome, wireBytes: 0 });
}

function boundedPositive(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be in 1..${maximum}`);
  }
  return value;
}
