// SPDX-License-Identifier: Apache-2.0

import { Buffer } from 'node:buffer';

import {
  SYSTEM_RECORD_MAX_NEGATIVE_MEMO_ENTRIES,
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_MAX_PEER_ID_BYTES,
  SYSTEM_RECORD_MAX_SLICE_REQUESTS,
  SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
  SYSTEM_RECORD_NEGATIVE_MEMO_ENTRY_BASE_BYTES,
  SYSTEM_RECORD_NEGATIVE_MEMO_TTL_MS,
  SYSTEM_RECORD_SLICE_TIMEOUT_MS,
  type Digest32V1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type {
  SystemRecordArtifactRepositoryV1,
  SystemRecordArtifactLookupV1,
  SystemRecordArtifactV1,
} from './artifact-v1.js';
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
  loadInventoryObject(
    request: AgentProfileInventoryLoadRequestV1,
    signal: AbortSignal,
  ): Promise<AgentProfileInventoryLoadResultV1>;
  release(): void;
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
  readonly closed: boolean;
}

export interface AgentProfileReconcileTransportV1 {
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
  readonly digest: Digest32V1;
  readonly failureClass: AgentProfileReconcileNegativeFailureClassV1;
  readonly expiresAtMs: number;
  readonly bytes: number;
  readonly reservation: { release(): void };
}

class AgentProfileReconcileTransportErrorV1 extends Error {
  readonly outcome: AgentProfileReconcileTransportFailureV1;

  constructor(outcome: AgentProfileReconcileTransportFailureV1) {
    super(`agent-profile exact transport failed: ${outcome}`);
    this.name = 'AgentProfileReconcileTransportErrorV1';
    this.outcome = outcome;
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
  const negativeMemo = new Map<string, NegativeMemoEntryV1>();
  let activeController: AbortController | undefined;
  let activeSlice = false;
  let requests = 0;
  let wireBytes = 0;
  let negativeMemoBytes = 0;
  let negativeMemoHits = 0;
  let negativeMemoWrites = 0;
  let negativeMemoEvictions = 0;
  let closed = false;
  let lastNowMs = 0;

  return Object.freeze({ openSlice, stats, close });

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
    activeController = controller;
    const signal = AbortSignal.any([callerSignal, controller.signal]);
    const leases: SystemRecordExactFetchLeaseV1[] = [];
    let sliceRequests = 0;
    let sliceWireBytes = 0;
    let released = false;

    const slice: AgentProfileReconcileTransportSliceV1 = Object.freeze({
      async resolve(
        lookup: SystemRecordArtifactLookupV1,
        callerSignal: AbortSignal,
      ): Promise<SystemRecordArtifactV1 | null> {
        if (lookup.type === 'root') {
          throw new Error('agent-profile reconcile transport requires an exact artifact');
        }
        if (lookup.type === 'object' && (
          lookup.objectKind === 'root-descriptor'
          || lookup.objectKind === 'inventory-internal'
          || lookup.objectKind === 'inventory-leaf'
        )) {
          throw new Error('agent-profile reconcile transport requires exact inventory coordinates');
        }
        const exactLookup: SystemRecordExactArtifactLookupV1 = lookup.type === 'inventory-object'
          ? lookup
          : Object.freeze({
              type: 'object',
              objectKind: lookup.objectKind as Extract<
                SystemRecordExactArtifactLookupV1,
                { type: 'object' }
              >['objectKind'],
              objectDigest: lookup.objectDigest,
            });
        const fetched = await resolveExact(exactLookup, callerSignal);
        if (fetched.outcome === 'ok') return fetched.lease.artifact;
        if (fetched.outcome === 'not-found' || fetched.outcome === 'unsupported') return null;
        throw new AgentProfileReconcileTransportErrorV1(fetched.outcome);
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
        if (fetched.outcome === 'ok') {
          return Object.freeze({
            outcome: 'ok',
            objectKind: fetched.lease.artifact.objectKind as typeof request.expectedKind,
            canonicalBytes: fetched.lease.artifact.canonicalBytes,
            wireBytes: fetched.lease.wireBytes,
          });
        }
        return Object.freeze({
          outcome: 'rejected',
          wireBytes: fetched.wireBytes,
          rejection: inventoryRejection(fetched.outcome),
        });
      },
      release,
    });
    return slice;

    async function resolveExact(
      lookup: SystemRecordExactArtifactLookupV1,
      callerSignal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> {
      if (released || closed) return Object.freeze({ outcome: 'closed', wireBytes: 0 });
      callerSignal.throwIfAborted();
      signal.throwIfAborted();
      const providers = providerSnapshot(listProviderIds());
      const digest = lookup.objectDigest;
      let selectedFailure: Exclude<
        SystemRecordExactFetchResultV1,
        { outcome: 'ok' }
      > | undefined;
      let attempted = false;
      for (const providerId of providers) {
        const now = readNow(nowMs);
        pruneExpired(now);
        if (now >= deadlineMs || signal.aborted || callerSignal.aborted) {
          signal.throwIfAborted();
          callerSignal.throwIfAborted();
          return Object.freeze({ outcome: 'deadline', wireBytes: 0 });
        }
        if (hasNegative(providerId, digest, now)) continue;
        if (sliceRequests >= SYSTEM_RECORD_MAX_SLICE_REQUESTS
          || sliceWireBytes >= SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES) {
          return Object.freeze({ outcome: 'capacity', wireBytes: 0 });
        }
        attempted = true;
        sliceRequests += 1;
        requests += 1;
        const attemptSignal = AbortSignal.any([signal, callerSignal]);
        const result = await fetchExact(providerId, lookup, attemptSignal);
        const completedAt = readNow(nowMs);
        const attemptWireBytes = result.outcome === 'ok'
          ? result.lease.wireBytes
          : result.wireBytes;
        const validWireBytes = Number.isSafeInteger(attemptWireBytes) && attemptWireBytes >= 0;
        if (validWireBytes) {
          sliceWireBytes += attemptWireBytes;
          wireBytes += attemptWireBytes;
        }
        if (released || closed || signal.aborted || callerSignal.aborted) {
          if (result.outcome === 'ok') result.lease.release();
          signal.throwIfAborted();
          callerSignal.throwIfAborted();
          return Object.freeze({
            outcome: 'closed',
            wireBytes: validWireBytes ? attemptWireBytes : 0,
          });
        }
        if (!validWireBytes) {
          if (result.outcome === 'ok') result.lease.release();
          selectedFailure = selectFailure(
            selectedFailure,
            Object.freeze({ outcome: 'invalid-response', wireBytes: 0 }),
          );
          rememberNegative(providerId, digest, 'invalid', completedAt);
          continue;
        }
        if (attemptWireBytes > SYSTEM_RECORD_MAX_FRAME_BYTES) {
          if (result.outcome === 'ok') result.lease.release();
          rememberNegative(providerId, digest, 'invalid', completedAt);
          if (sliceWireBytes > SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES) {
            return Object.freeze({ outcome: 'capacity', wireBytes: attemptWireBytes });
          }
          selectedFailure = selectFailure(
            selectedFailure,
            Object.freeze({ outcome: 'invalid-response', wireBytes: attemptWireBytes }),
          );
          continue;
        }
        if (sliceWireBytes > SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES) {
          if (result.outcome === 'ok') result.lease.release();
          return Object.freeze({ outcome: 'capacity', wireBytes: attemptWireBytes });
        }
        if (completedAt >= deadlineMs) {
          if (result.outcome === 'ok') result.lease.release();
          rememberNegative(providerId, digest, 'timeout', completedAt);
          return Object.freeze({ outcome: 'deadline', wireBytes: attemptWireBytes });
        }
        if (result.outcome === 'ok') {
          if (result.lease.artifact.objectKind !== lookup.objectKind
            || result.lease.artifact.objectDigest !== lookup.objectDigest
            || !(result.lease.artifact.canonicalBytes instanceof Uint8Array)) {
            result.lease.release();
            selectedFailure = selectFailure(selectedFailure, Object.freeze({
              outcome: 'invalid-response',
              wireBytes: attemptWireBytes,
            }));
            rememberNegative(providerId, digest, 'invalid', completedAt);
            continue;
          }
          leases.push(result.lease);
          return result;
        }
        selectedFailure = selectFailure(selectedFailure, result);
        const failureClass = negativeFailureClass(result.outcome);
        if (failureClass !== null) {
          rememberNegative(providerId, digest, failureClass, completedAt);
        }
      }
      return attempted
        ? selectedFailure ?? Object.freeze({ outcome: 'busy', wireBytes: 0 })
        : Object.freeze({ outcome: 'busy', wireBytes: 0 });
    }

    function release(): void {
      if (released) return;
      released = true;
      controller.abort(new Error('agent-profile reconcile transport slice released'));
      for (const lease of leases.splice(0)) lease.release();
      if (activeController === controller) activeController = undefined;
      activeSlice = false;
    }
  }

  function hasNegative(providerId: string, digest: Digest32V1, now: number): boolean {
    for (const failureClass of ['timeout', 'absence', 'invalid'] as const) {
      const entry = negativeMemo.get(memoKey(providerId, digest, failureClass));
      if (entry === undefined) continue;
      if (entry.expiresAtMs <= now) {
        deleteMemoEntry(entry, false);
        continue;
      }
      negativeMemoHits += 1;
      return true;
    }
    return false;
  }

  function rememberNegative(
    providerId: string,
    digest: Digest32V1,
    failureClass: AgentProfileReconcileNegativeFailureClassV1,
    observedAtMs: number,
  ): void {
    pruneExpired(observedAtMs);
    const key = memoKey(providerId, digest, failureClass);
    if (negativeMemo.has(key)) return;
    while (negativeMemo.size >= maxNegativeEntries) {
      const oldest = negativeMemo.values().next().value as NegativeMemoEntryV1 | undefined;
      if (oldest === undefined) break;
      deleteMemoEntry(oldest, true);
    }
    const bytes = SYSTEM_RECORD_NEGATIVE_MEMO_ENTRY_BASE_BYTES + Buffer.byteLength(key, 'utf8');
    const reservation = controlAdmission.tryReserve(bytes);
    if (reservation === null) return;
    const expiresAtMs = observedAtMs + negativeTtlMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      reservation.release();
      return;
    }
    const entry = Object.freeze({
      providerId,
      digest,
      failureClass,
      expiresAtMs,
      bytes,
      reservation,
    });
    negativeMemo.set(key, entry);
    negativeMemoBytes += bytes;
    negativeMemoWrites += 1;
  }

  function pruneExpired(now: number): void {
    for (const entry of negativeMemo.values()) {
      if (entry.expiresAtMs > now) continue;
      deleteMemoEntry(entry, false);
    }
  }

  function deleteMemoEntry(entry: NegativeMemoEntryV1, evicted: boolean): void {
    const key = memoKey(entry.providerId, entry.digest, entry.failureClass);
    if (negativeMemo.get(key) !== entry) return;
    negativeMemo.delete(key);
    negativeMemoBytes -= entry.bytes;
    entry.reservation.release();
    if (evicted) negativeMemoEvictions += 1;
  }

  function stats(): AgentProfileReconcileTransportStatsV1 {
    return Object.freeze({
      activeSlice: activeSlice ? 1 : 0,
      requests,
      wireBytes,
      negativeMemoEntries: negativeMemo.size,
      negativeMemoBytes,
      negativeMemoHits,
      negativeMemoWrites,
      negativeMemoEvictions,
      closed,
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    activeController?.abort(new Error('agent-profile reconcile transport closed'));
    for (const entry of [...negativeMemo.values()]) deleteMemoEntry(entry, false);
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

function providerSnapshot(input: readonly string[]): readonly string[] {
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
    if (providers.length === SYSTEM_RECORD_MAX_SLICE_REQUESTS) break;
  }
  return Object.freeze(providers);
}

function negativeFailureClass(
  outcome: AgentProfileReconcileTransportFailureV1,
): AgentProfileReconcileNegativeFailureClassV1 | null {
  switch (outcome) {
    case 'deadline': return 'timeout';
    case 'not-found':
    case 'unsupported': return 'absence';
    case 'invalid-response': return 'invalid';
    case 'remote-busy':
    case 'remote-error':
    case 'busy':
    case 'capacity':
    case 'waiter-limit':
    case 'transport':
    case 'closed': return null;
  }
}

function selectFailure(
  current: Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }> | undefined,
  candidate: Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }>,
): Exclude<SystemRecordExactFetchResultV1, { outcome: 'ok' }> {
  if (current === undefined) return candidate;
  return failureRank(candidate.outcome) > failureRank(current.outcome) ? candidate : current;
}

function failureRank(outcome: AgentProfileReconcileTransportFailureV1): number {
  switch (outcome) {
    case 'invalid-response': return 5;
    case 'deadline': return 4;
    case 'transport':
    case 'remote-error': return 3;
    case 'remote-busy':
    case 'busy':
    case 'capacity':
    case 'waiter-limit':
    case 'closed': return 2;
    case 'not-found':
    case 'unsupported': return 1;
  }
}

function inventoryRejection(
  outcome: AgentProfileReconcileTransportFailureV1,
): 'not-found' | 'invalid-response' | 'busy' | 'transport' {
  switch (outcome) {
    case 'not-found':
    case 'unsupported': return 'not-found';
    case 'invalid-response': return 'invalid-response';
    case 'remote-busy':
    case 'busy':
    case 'capacity':
    case 'waiter-limit': return 'busy';
    case 'deadline':
    case 'remote-error':
    case 'transport':
    case 'closed': return 'transport';
  }
}

function memoKey(
  providerId: string,
  digest: Digest32V1,
  failureClass: AgentProfileReconcileNegativeFailureClassV1,
): string {
  return JSON.stringify([providerId, digest, failureClass]);
}

function boundedPositive(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be in 1..${maximum}`);
  }
  return value;
}
