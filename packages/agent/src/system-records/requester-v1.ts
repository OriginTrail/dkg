// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';

import {
  SYSTEM_RECORD_MAX_EXACT_FETCH_WAITERS,
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_MAX_PENDING_EXACT_FETCHES,
  SYSTEM_RECORD_PROVIDER_EXCHANGE_TIMEOUT_MS,
  decodeSystemRecordResponseFrameV1,
  encodeSystemRecordRequestFrameV1,
  verifySystemRecordResponsePayloadV1,
  type SystemRecordRequestHeaderV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { SystemRecordArtifactV1 } from './artifact-v1.js';
import type {
  CreateSystemRecordRequesterOptionsV1,
  SystemRecordExactArtifactLookupV1,
  SystemRecordExactFetchLeaseV1,
  SystemRecordExactFetchResultV1,
  SystemRecordRequesterByteReservationV1,
  SystemRecordRequesterExchangeV1,
  SystemRecordRequesterPermitV1,
  SystemRecordRequesterResetReasonV1,
  SystemRecordRequesterStatsV1,
  SystemRecordRequesterV1,
} from './requester-api-v1.js';
import {
  createSystemRecordExactRequestV1,
  systemRecordExactRequestKeyV1,
  systemRecordExactResponseOutcomeV1,
} from './requester-wire-v1-internal.js';

interface RetainedFetchV1 {
  readonly artifact: SystemRecordArtifactV1;
  readonly reservation: SystemRecordRequesterByteReservationV1;
  readonly decodePermit: SystemRecordRequesterPermitV1;
  readonly wireBytes: number;
}

type SharedFetchOutcomeV1 =
  | Readonly<{ outcome: 'ok'; retained: RetainedFetchV1 }>
  | Exclude<SystemRecordExactFetchResultV1, Readonly<{ outcome: 'ok'; lease: SystemRecordExactFetchLeaseV1 }>>;

interface FetchSubscriberV1 {
  readonly signal: AbortSignal;
  readonly resolve: (result: SystemRecordExactFetchResultV1) => void;
  readonly reject: (reason?: unknown) => void;
  readonly onAbort: () => void;
  state: 'waiting' | 'leased' | 'done';
}

interface FetchEntryV1 {
  readonly key: string;
  readonly controller: AbortController;
  readonly subscribers: Set<FetchSubscriberV1>;
  abortReason?: SystemRecordRequesterResetReasonV1;
  settled: boolean;
  retained?: RetainedFetchV1;
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
      // The first subscriber owns the transfer; the frozen limit counts followers.
      if (entry.subscribers.size >= maxWaitersPerDigest + 1) {
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
      subscribers: new Set(),
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
      const subscriber: FetchSubscriberV1 = {
        signal,
        resolve,
        reject,
        state: 'waiting',
        onAbort: () => {
          if (subscriber.state !== 'waiting') return;
          subscriber.state = 'done';
          entry.subscribers.delete(subscriber);
          waitingCallers -= 1;
          reject(signal.reason);
          abortIfUnobserved(entry);
        },
      };
      entry.subscribers.add(subscriber);
      waitingCallers += 1;
      signal.addEventListener('abort', subscriber.onAbort, { once: true });
      if (signal.aborted) {
        subscriber.onAbort();
        return;
      }
      if (entry.settled && entry.retained !== undefined) deliverLease(entry, subscriber);
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
    let shared: SharedFetchOutcomeV1;
    try {
      const requestFrame = encodeSystemRecordRequestFrameV1(request);
      exchange = await raceAbort(openExchange(entry.controller.signal), entry.controller.signal);
      await raceAbort(
        exchange.writeRequestFrame(requestFrame, entry.controller.signal),
        entry.controller.signal,
      );
      wireBytes += requestFrame.byteLength;
      const responseFrame = await raceAbort(
        exchange.readResponseFrame(SYSTEM_RECORD_MAX_FRAME_BYTES, entry.controller.signal),
        entry.controller.signal,
      );
      if (responseFrame instanceof Uint8Array) wireBytes += responseFrame.byteLength;
      if (!(responseFrame instanceof Uint8Array)
        || responseFrame.byteLength < 1
        || responseFrame.byteLength > SYSTEM_RECORD_MAX_FRAME_BYTES) {
        throw new InvalidSystemRecordResponseError();
      }
      frameReservation.shrinkTo(responseFrame.byteLength);
      let decoded: ReturnType<typeof decodeSystemRecordResponseFrameV1>;
      try {
        decoded = decodeSystemRecordResponseFrameV1(responseFrame);
        verifySystemRecordResponsePayloadV1(request, decoded.header, decoded.payload);
      } catch {
        throw new InvalidSystemRecordResponseError();
      }
      if (decoded.header.status !== 'ok') {
        shared = Object.freeze({
          outcome: systemRecordExactResponseOutcomeV1(decoded.header.status),
          wireBytes,
        });
      } else {
        const decodePermit = options.decodeAdmission.tryAcquire();
        if (decodePermit === null) {
          shared = Object.freeze({ outcome: 'busy', wireBytes });
        } else {
          const payloadReservation = options.byteAdmission.tryReserve(decoded.payload.byteLength);
          if (payloadReservation === null) {
            decodePermit.release();
            shared = Object.freeze({ outcome: 'capacity', wireBytes });
          } else {
            try {
              const canonicalBytes = Uint8Array.from(decoded.payload);
              const retained: RetainedFetchV1 = Object.freeze({
                artifact: Object.freeze({
                  objectKind: decoded.header.objectKind,
                  objectDigest: decoded.header.objectDigest,
                  canonicalBytes,
                }),
                reservation: payloadReservation,
                decodePermit,
                wireBytes,
              });
              entry.retained = retained;
              retainedPayloadBytes += canonicalBytes.byteLength;
              shared = Object.freeze({ outcome: 'ok', retained });
            } catch (error) {
              payloadReservation.release();
              decodePermit.release();
              throw error;
            }
          }
        }
      }
    } catch (error) {
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

  function settle(entry: FetchEntryV1, shared: SharedFetchOutcomeV1): void {
    entry.settled = true;
    if (shared.outcome === 'ok') {
      for (const subscriber of [...entry.subscribers]) deliverLease(entry, subscriber);
      abortIfUnobserved(entry);
      return;
    }
    entries.delete(entry.key);
    for (const subscriber of [...entry.subscribers]) {
      if (subscriber.state !== 'waiting') continue;
      subscriber.signal.removeEventListener('abort', subscriber.onAbort);
      subscriber.state = 'done';
      waitingCallers -= 1;
      entry.subscribers.delete(subscriber);
      subscriber.resolve(shared);
    }
  }

  function deliverLease(entry: FetchEntryV1, subscriber: FetchSubscriberV1): void {
    if (subscriber.state !== 'waiting' || entry.retained === undefined) return;
    subscriber.signal.removeEventListener('abort', subscriber.onAbort);
    subscriber.state = 'leased';
    waitingCallers -= 1;
    activeLeases += 1;
    let released = false;
    const retained = entry.retained;
    subscriber.resolve(Object.freeze({
      outcome: 'ok',
      lease: Object.freeze({
        artifact: retained.artifact,
        wireBytes: retained.wireBytes,
        release(): void {
          if (released) return;
          released = true;
          subscriber.state = 'done';
          entry.subscribers.delete(subscriber);
          activeLeases -= 1;
          releaseRetainedIfUnobserved(entry);
        },
      }),
    }));
  }

  function abortIfUnobserved(entry: FetchEntryV1): void {
    if (entry.subscribers.size !== 0) return;
    if (!entry.settled) {
      abortEntry(entry, 'cancelled', new Error('system-record requester has no callers'));
    }
    releaseRetainedIfUnobserved(entry);
  }

  function releaseRetainedIfUnobserved(entry: FetchEntryV1): void {
    if (entry.subscribers.size !== 0 || entry.retained === undefined) return;
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

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

class InvalidSystemRecordResponseError extends Error {}
