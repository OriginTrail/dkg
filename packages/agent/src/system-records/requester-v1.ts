// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';

import {
  SYSTEM_RECORD_MAX_EXACT_FETCH_WAITERS,
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_MAX_PENDING_EXACT_FETCHES,
  SYSTEM_RECORD_PROVIDER_EXCHANGE_TIMEOUT_MS,
  type SystemRecordRequestHeaderV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type {
  CreateSystemRecordRequesterOptionsV1,
  SystemRecordExactArtifactLookupV1,
  SystemRecordExactFetchResultV1,
  SystemRecordRequesterByteReservationV1,
  SystemRecordRequesterExchangeV1,
  SystemRecordRequesterPermitV1,
  SystemRecordRequesterResetReasonV1,
  SystemRecordRequesterStatsV1,
  SystemRecordRequesterV1,
} from './requester-api-v1.js';
import {
  InvalidSystemRecordResponseError,
  SystemRecordRequesterTransferError,
  exchangeSystemRecordResponseV1,
  retainVerifiedSystemRecordResponseV1,
  type SystemRecordRetainedSourceV1,
  type SystemRecordRetainTransferResultV1,
} from './requester-transfer-v1-internal.js';
import {
  createSystemRecordExactRequestV1,
  systemRecordExactRequestKeyV1,
} from './requester-wire-v1-internal.js';
import { raceSystemRecordAbortV1 } from './transport-v1.js';

interface FetchWaiterV1 {
  readonly signal: AbortSignal;
  readonly resolve: (result: SystemRecordExactFetchResultV1) => void;
  readonly reject: (reason?: unknown) => void;
  readonly onAbort: () => void;
}

interface FetchEntryV1 {
  readonly key: string;
  readonly controller: AbortController;
  readonly waiters: Set<FetchWaiterV1>;
  leaseCount: number;
  abortReason?: SystemRecordRequesterResetReasonV1;
  settled: boolean;
  retained?: SystemRecordRetainedSourceV1;
}

/**
 * One default-unused exact requester. Same-coordinate calls share one transfer,
 * while unrelated digests never wait behind the single process-wide stream.
 */
export function createSystemRecordRequesterV1(
  options: CreateSystemRecordRequesterOptionsV1,
): SystemRecordRequesterV1 {
  const requestId = options.requestId ?? (() => randomBytes(16).toString('hex'));
  const timeoutMs = boundedPositive(
    options.timeoutMs ?? SYSTEM_RECORD_PROVIDER_EXCHANGE_TIMEOUT_MS,
    SYSTEM_RECORD_PROVIDER_EXCHANGE_TIMEOUT_MS,
    'requester timeoutMs',
  );
  const maxPendingDigests = boundedPositive(
    options.maxPendingDigests ?? SYSTEM_RECORD_MAX_PENDING_EXACT_FETCHES,
    SYSTEM_RECORD_MAX_PENDING_EXACT_FETCHES,
    'maxPendingDigests',
  );
  const maxWaitersPerDigest = boundedPositive(
    options.maxWaitersPerDigest ?? SYSTEM_RECORD_MAX_EXACT_FETCH_WAITERS,
    SYSTEM_RECORD_MAX_EXACT_FETCH_WAITERS,
    'maxWaitersPerDigest',
  );
  const entries = new Map<string, FetchEntryV1>();
  let started = 0;
  let joined = 0;
  let completed = 0;
  let waitingCallers = 0;
  let activeLeases = 0;
  let activeStream: 0 | 1 = 0;
  let peakActiveStream: 0 | 1 = 0;
  let retainedPayloadBytes = 0;
  let closed = false;

  return Object.freeze({ fetch, stats, close });

  async function fetch(
    lookup: SystemRecordExactArtifactLookupV1,
    openExchange: (signal: AbortSignal) => Promise<SystemRecordRequesterExchangeV1>,
    signal: AbortSignal,
  ): Promise<SystemRecordExactFetchResultV1> {
    signal.throwIfAborted();
    if (closed) return Object.freeze({ outcome: 'closed', wireBytes: 0 });
    const request = createSystemRecordExactRequestV1(options.networkId, lookup, requestId());
    const key = systemRecordExactRequestKeyV1(request);
    let entry = entries.get(key);
    if (entry !== undefined) {
      // The first observer owns the transfer; the frozen limit counts followers.
      if (entry.waiters.size + entry.leaseCount >= maxWaitersPerDigest + 1) {
        return Object.freeze({ outcome: 'waiter-limit', wireBytes: 0 });
      }
      joined += 1;
      return subscribe(entry, signal);
    }
    if (entries.size >= maxPendingDigests) {
      return Object.freeze({ outcome: 'capacity', wireBytes: 0 });
    }
    const streamPermit = options.streamAdmission.tryAcquire();
    if (streamPermit === null) return Object.freeze({ outcome: 'busy', wireBytes: 0 });
    const frameReservation = options.byteAdmission.tryReserve(SYSTEM_RECORD_MAX_FRAME_BYTES);
    if (frameReservation === null) {
      streamPermit.release();
      return Object.freeze({ outcome: 'capacity', wireBytes: 0 });
    }
    entry = {
      key,
      controller: new AbortController(),
      waiters: new Set(),
      leaseCount: 0,
      settled: false,
    };
    entries.set(key, entry);
    started += 1;
    activeStream = 1;
    peakActiveStream = 1;
    void run(entry, request, openExchange, streamPermit, frameReservation);
    return subscribe(entry, signal);
  }

  function subscribe(
    entry: FetchEntryV1,
    signal: AbortSignal,
  ): Promise<SystemRecordExactFetchResultV1> {
    return new Promise<SystemRecordExactFetchResultV1>((resolve, reject) => {
      const waiter: FetchWaiterV1 = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          if (!entry.waiters.delete(waiter)) return;
          waitingCallers -= 1;
          reject(signal.reason);
          abortIfUnobserved(entry);
        },
      };
      entry.waiters.add(waiter);
      waitingCallers += 1;
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      if (signal.aborted) {
        waiter.onAbort();
        return;
      }
      if (entry.settled && entry.retained !== undefined) deliverLease(entry, waiter);
    });
  }

  async function run(
    entry: FetchEntryV1,
    request: SystemRecordRequestHeaderV1,
    openExchange: (signal: AbortSignal) => Promise<SystemRecordRequesterExchangeV1>,
    streamPermit: SystemRecordRequesterPermitV1,
    frameReservation: SystemRecordRequesterByteReservationV1,
  ): Promise<void> {
    let exchange: SystemRecordRequesterExchangeV1 | undefined;
    let wireBytes = 0;
    const timeout = setTimeout(
      () => abortEntry(
        entry,
        'deadline',
        new Error('system-record requester deadline exceeded'),
      ),
      timeoutMs,
    );
    timeout.unref?.();
    let shared: SystemRecordRetainTransferResultV1;
    try {
      exchange = await raceSystemRecordAbortV1(
        openExchange(entry.controller.signal),
        entry.controller.signal,
      );
      const transfer = await exchangeSystemRecordResponseV1({
        request,
        exchange,
        frameReservation,
        signal: entry.controller.signal,
      });
      wireBytes = transfer.wireBytes;
      shared = retainVerifiedSystemRecordResponseV1({
        request,
        transfer,
        decodeAdmission: options.decodeAdmission,
        byteAdmission: options.byteAdmission,
      });
      if (shared.outcome === 'ok') {
        entry.retained = shared.retained;
        retainedPayloadBytes += shared.retained.artifact.canonicalBytes.byteLength;
      }
    } catch (error) {
      if (error instanceof SystemRecordRequesterTransferError) {
        wireBytes = error.wireBytes;
      }
      const outcome = error instanceof InvalidSystemRecordResponseError
        ? 'invalid-response'
        : entry.controller.signal.aborted
          ? entry.abortReason === 'closed'
            ? 'closed'
            : entry.abortReason === 'deadline'
              ? 'deadline'
              : 'transport'
          : 'transport';
      try {
        exchange?.reset(
          outcome === 'invalid-response'
            ? 'invalid-response'
            : entry.abortReason ?? outcome,
        );
      } catch {
        // Reset is best-effort cleanup and cannot strand the single-flight entry.
      }
      shared = Object.freeze({ outcome, wireBytes });
    } finally {
      clearTimeout(timeout);
      frameReservation.release();
      streamPermit.release();
      activeStream = 0;
      completed += 1;
    }
    settle(entry, shared);
  }

  function settle(entry: FetchEntryV1, shared: SystemRecordRetainTransferResultV1): void {
    entry.settled = true;
    if (shared.outcome === 'ok') {
      for (const waiter of [...entry.waiters]) deliverLease(entry, waiter);
      abortIfUnobserved(entry);
      return;
    }
    entries.delete(entry.key);
    for (const waiter of [...entry.waiters]) {
      if (!entry.waiters.delete(waiter)) continue;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waitingCallers -= 1;
      waiter.resolve(shared);
    }
  }

  function deliverLease(entry: FetchEntryV1, waiter: FetchWaiterV1): void {
    const retained = entry.retained;
    if (retained === undefined || !entry.waiters.delete(waiter)) return;
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    waitingCallers -= 1;
    const payloadBytes = retained.artifact.canonicalBytes.byteLength;
    const reservation = options.byteAdmission.tryReserve(payloadBytes);
    if (reservation === null) {
      waiter.resolve(Object.freeze({ outcome: 'capacity', wireBytes: retained.wireBytes }));
      releaseRetainedIfUnobserved(entry);
      return;
    }
    let canonicalBytes: Uint8Array;
    try {
      canonicalBytes = Uint8Array.from(retained.artifact.canonicalBytes);
    } catch {
      reservation.release();
      waiter.resolve(Object.freeze({ outcome: 'capacity', wireBytes: retained.wireBytes }));
      releaseRetainedIfUnobserved(entry);
      return;
    }
    entry.leaseCount += 1;
    activeLeases += 1;
    retainedPayloadBytes += payloadBytes;
    let released = false;
    waiter.resolve(Object.freeze({
      outcome: 'ok',
      lease: Object.freeze({
        artifact: Object.freeze({
          objectKind: retained.artifact.objectKind,
          objectDigest: retained.artifact.objectDigest,
          canonicalBytes,
        }),
        wireBytes: retained.wireBytes,
        release(): void {
          if (released) return;
          released = true;
          entry.leaseCount -= 1;
          activeLeases -= 1;
          retainedPayloadBytes -= payloadBytes;
          reservation.release();
          releaseRetainedIfUnobserved(entry);
        },
      }),
    }));
  }

  function abortIfUnobserved(entry: FetchEntryV1): void {
    if (entry.waiters.size !== 0 || entry.leaseCount !== 0) return;
    if (!entry.settled) {
      abortEntry(entry, 'cancelled', new Error('system-record requester has no callers'));
    }
    releaseRetainedIfUnobserved(entry);
  }

  function releaseRetainedIfUnobserved(entry: FetchEntryV1): void {
    if (entry.waiters.size !== 0 || entry.leaseCount !== 0 || entry.retained === undefined) return;
    entries.delete(entry.key);
    retainedPayloadBytes -= entry.retained.artifact.canonicalBytes.byteLength;
    entry.retained.reservation.release();
    entry.retained.decodePermit.release();
    entry.retained = undefined;
  }

  function stats(): SystemRecordRequesterStatsV1 {
    return Object.freeze({
      started,
      joined,
      completed,
      pendingDigests: entries.size,
      waitingCallers,
      activeLeases,
      activeStream,
      peakActiveStream,
      queuedStreams: 0,
      retainedPayloadBytes,
      closed,
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    for (const entry of entries.values()) {
      if (!entry.settled) {
        abortEntry(entry, 'closed', new Error('system-record requester closed'));
      }
    }
  }

  function abortEntry(
    entry: FetchEntryV1,
    reason: SystemRecordRequesterResetReasonV1,
    error: Error,
  ): void {
    if (entry.controller.signal.aborted) return;
    entry.abortReason = reason;
    entry.controller.abort(error);
  }
}

function boundedPositive(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be in 1..${maximum}`);
  }
  return value;
}
