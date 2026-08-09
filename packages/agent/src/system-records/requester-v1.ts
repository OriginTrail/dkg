// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';

import {
  SYSTEM_RECORD_MAX_EXACT_FETCH_WAITERS,
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_MAX_PENDING_EXACT_FETCHES,
  SYSTEM_RECORD_PROVIDER_EXCHANGE_TIMEOUT_MS,
  type SystemRecordRequestHeaderV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { cloneSystemRecordArtifactV1 } from './artifact-v1.js';
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
  openSystemRecordRequesterExchangeV1,
  retainVerifiedSystemRecordResponseV1,
  type SystemRecordRetainedSourceV1,
} from './requester-transfer-v1-internal.js';
import {
  createSystemRecordExactRequestV1,
} from './requester-wire-v1-internal.js';
import { raceSystemRecordAbortV1 } from './transport-v1.js';

type SystemRecordRequesterSettlementV1 =
  | Readonly<{ outcome: 'ok'; wireBytes: number }>
  | Exclude<SystemRecordExactFetchResultV1, Readonly<{ outcome: 'ok' }>>;

interface PendingFetchPhaseV1 {
  readonly state: 'pending';
  readonly controller: AbortController;
  readonly transfer: Promise<SystemRecordRequesterSettlementV1>;
  abortReason?: SystemRecordRequesterResetReasonV1;
}

interface RetainedFetchPhaseV1 {
  readonly state: 'retained';
  readonly source: SystemRecordRetainedSourceV1;
}

interface FetchEntryV1 {
  readonly key: string;
  observerCount: number;
  leaseCount: number;
  phase: PendingFetchPhaseV1 | RetainedFetchPhaseV1;
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
    signal: AbortSignal,
  ): Promise<SystemRecordExactFetchResultV1> {
    signal.throwIfAborted();
    if (closed) return Object.freeze({ outcome: 'closed', wireBytes: 0 });
    const exact = createSystemRecordExactRequestV1(options.networkId, lookup, requestId());
    const { key, request } = exact;
    let entry = entries.get(key);
    if (entry !== undefined) {
      if (entry.phase.state === 'pending' && entry.phase.controller.signal.aborted) {
        return Object.freeze({ outcome: 'busy', wireBytes: 0 });
      }
      // The first observer owns the transfer; the frozen limit counts followers.
      if (entry.observerCount + entry.leaseCount >= maxWaitersPerDigest + 1) {
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
    let resolveTransfer!: (result: SystemRecordRequesterSettlementV1) => void;
    let rejectTransfer!: (reason?: unknown) => void;
    const transfer = new Promise<SystemRecordRequesterSettlementV1>((resolve, reject) => {
      resolveTransfer = resolve;
      rejectTransfer = reject;
    });
    entry = {
      key,
      observerCount: 0,
      leaseCount: 0,
      phase: {
        state: 'pending',
        controller: new AbortController(),
        transfer,
      },
    };
    entries.set(key, entry);
    started += 1;
    activeStream = 1;
    peakActiveStream = 1;
    void run(entry, request, streamPermit, frameReservation).then(
      resolveTransfer,
      rejectTransfer,
    );
    return subscribe(entry, signal);
  }

  async function subscribe(
    entry: FetchEntryV1,
    signal: AbortSignal,
  ): Promise<SystemRecordExactFetchResultV1> {
    entry.observerCount += 1;
    waitingCallers += 1;
    let observing = true;
    const releaseObserver = () => {
      if (!observing) return;
      observing = false;
      entry.observerCount -= 1;
      waitingCallers -= 1;
      abortIfUnobserved(entry);
    };
    signal.addEventListener('abort', releaseObserver, { once: true });
    if (signal.aborted) {
      releaseObserver();
      signal.throwIfAborted();
    }
    try {
      const phase = entry.phase;
      if (phase.state === 'retained') return deliverLease(entry, phase.source);
      const shared = await raceSystemRecordAbortV1(phase.transfer, signal);
      if (shared.outcome !== 'ok') return shared;
      const retained = entry.phase;
      if (retained.state !== 'retained') {
        throw new Error('successful System Record transfer has no retained source');
      }
      return deliverLease(entry, retained.source);
    } finally {
      signal.removeEventListener('abort', releaseObserver);
      releaseObserver();
    }
  }

  async function run(
    entry: FetchEntryV1,
    request: SystemRecordRequestHeaderV1,
    streamPermit: SystemRecordRequesterPermitV1,
    frameReservation: SystemRecordRequesterByteReservationV1,
  ): Promise<SystemRecordRequesterSettlementV1> {
    const pending = entry.phase;
    if (pending.state !== 'pending') {
      throw new Error('System Record transfer started outside the pending phase');
    }
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
    let shared: SystemRecordRequesterSettlementV1;
    try {
      exchange = await openSystemRecordRequesterExchangeV1({
        openExchange: options.openExchange,
        signal: pending.controller.signal,
        resetReason: () => pending.abortReason ?? 'cancelled',
      });
      const transfer = await exchangeSystemRecordResponseV1({
        request,
        exchange,
        frameReservation,
        signal: pending.controller.signal,
      });
      wireBytes = transfer.wireBytes;
      const retained = retainVerifiedSystemRecordResponseV1({
        request,
        transfer,
        decodeAdmission: options.decodeAdmission,
        byteAdmission: options.byteAdmission,
      });
      if (retained.outcome === 'ok') {
        entry.phase = Object.freeze({ state: 'retained', source: retained.retained });
        retainedPayloadBytes += retained.retained.artifact.canonicalBytes.byteLength;
        shared = Object.freeze({ outcome: 'ok', wireBytes: retained.retained.wireBytes });
      } else {
        shared = retained;
      }
    } catch (error) {
      if (error instanceof SystemRecordRequesterTransferError) {
        wireBytes = error.wireBytes;
      }
      const outcome = error instanceof InvalidSystemRecordResponseError
        ? 'invalid-response'
        : pending.controller.signal.aborted
          ? pending.abortReason === 'closed'
            ? 'closed'
            : pending.abortReason === 'deadline'
              ? 'deadline'
              : 'transport'
          : 'transport';
      try {
        exchange?.reset(
          outcome === 'invalid-response'
            ? 'invalid-response'
            : pending.abortReason ?? outcome,
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
    if (shared.outcome !== 'ok' && entries.get(entry.key) === entry) entries.delete(entry.key);
    return shared;
  }

  function deliverLease(
    entry: FetchEntryV1,
    retained: SystemRecordRetainedSourceV1,
  ): SystemRecordExactFetchResultV1 {
    const payloadBytes = retained.artifact.canonicalBytes.byteLength;
    const reservation = options.byteAdmission.tryReserve(payloadBytes);
    if (reservation === null) {
      return Object.freeze({ outcome: 'capacity', wireBytes: retained.wireBytes });
    }
    let artifact: ReturnType<typeof cloneSystemRecordArtifactV1>;
    try {
      artifact = cloneSystemRecordArtifactV1(retained.artifact);
    } catch {
      reservation.release();
      return Object.freeze({ outcome: 'capacity', wireBytes: retained.wireBytes });
    }
    entry.leaseCount += 1;
    activeLeases += 1;
    retainedPayloadBytes += payloadBytes;
    let released = false;
    return Object.freeze({
      outcome: 'ok',
      lease: Object.freeze({
        artifact,
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
    });
  }

  function abortIfUnobserved(entry: FetchEntryV1): void {
    if (entry.observerCount !== 0 || entry.leaseCount !== 0) return;
    if (entries.get(entry.key) !== entry) return;
    if (entry.phase.state === 'pending') {
      abortEntry(entry, 'cancelled', new Error('system-record requester has no callers'));
    }
    releaseRetainedIfUnobserved(entry);
  }

  function releaseRetainedIfUnobserved(entry: FetchEntryV1): void {
    if (entry.observerCount !== 0 || entry.leaseCount !== 0) return;
    const phase = entry.phase;
    if (phase.state !== 'retained') return;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    retainedPayloadBytes -= phase.source.artifact.canonicalBytes.byteLength;
    phase.source.release();
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
      if (entry.phase.state === 'pending') {
        abortEntry(entry, 'closed', new Error('system-record requester closed'));
      }
    }
  }

  function abortEntry(
    entry: FetchEntryV1,
    reason: SystemRecordRequesterResetReasonV1,
    error: Error,
  ): void {
    const phase = entry.phase;
    if (phase.state !== 'pending' || phase.controller.signal.aborted) return;
    phase.abortReason = reason;
    phase.controller.abort(error);
  }
}

function boundedPositive(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be in 1..${maximum}`);
  }
  return value;
}
