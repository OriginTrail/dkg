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
  SystemRecordRequesterByteAdmissionV1,
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

export type {
  CreateSystemRecordRequesterOptionsV1,
  SystemRecordExactArtifactLookupV1,
  SystemRecordExactFetchLeaseV1,
  SystemRecordExactFetchResultV1,
  SystemRecordRequesterAdmissionV1,
  SystemRecordRequesterByteAdmissionV1,
  SystemRecordRequesterByteReservationV1,
  SystemRecordRequesterExchangeV1,
  SystemRecordRequesterPermitV1,
  SystemRecordRequesterResetReasonV1,
  SystemRecordRequesterStatsV1,
  SystemRecordRequesterV1,
} from './requester-api-v1.js';

type SystemRecordRequesterFailureV1 = Exclude<
  SystemRecordExactFetchResultV1,
  Readonly<{ outcome: 'ok' }>
>;

type SystemRecordRequesterSettlementV1 =
  | Readonly<{ state: 'retained'; source: SystemRecordRetainedSourceV1 }>
  | Readonly<{ state: 'failed'; result: SystemRecordRequesterFailureV1 }>;

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

interface SettledFetchPhaseV1 {
  readonly state: 'failed' | 'disposed';
}

type FetchPhaseV1 = PendingFetchPhaseV1 | RetainedFetchPhaseV1 | SettledFetchPhaseV1;

interface FetchEntryV1 {
  readonly key: string;
  phase: FetchPhaseV1;
  observerCount: number;
  leaseCount: number;
}

class ExactFetchRegistryV1 {
  readonly #entries = new Map<string, FetchEntryV1>();
  readonly #byteAdmission: SystemRecordRequesterByteAdmissionV1;
  #waitingCallers = 0;
  #activeLeases = 0;
  #retainedPayloadBytes = 0;

  constructor(byteAdmission: SystemRecordRequesterByteAdmissionV1) {
    this.#byteAdmission = byteAdmission;
  }

  get size(): number {
    return this.#entries.size;
  }

  get waitingCallers(): number {
    return this.#waitingCallers;
  }

  get activeLeases(): number {
    return this.#activeLeases;
  }

  get retainedPayloadBytes(): number {
    return this.#retainedPayloadBytes;
  }

  get(key: string): FetchEntryV1 | undefined {
    return this.#entries.get(key);
  }

  create(key: string, pending: PendingFetchPhaseV1): FetchEntryV1 {
    const entry: FetchEntryV1 = { key, phase: pending, observerCount: 0, leaseCount: 0 };
    this.#entries.set(key, entry);
    return entry;
  }

  snapshot(entry: FetchEntryV1): FetchPhaseV1 {
    return entry.phase;
  }

  pendingAborted(entry: FetchEntryV1): boolean {
    return entry.phase.state === 'pending' && entry.phase.controller.signal.aborted;
  }

  participantCount(entry: FetchEntryV1): number {
    return entry.observerCount + entry.leaseCount;
  }

  addObserver(entry: FetchEntryV1): void {
    entry.observerCount += 1;
    this.#waitingCallers += 1;
  }

  releaseObserver(entry: FetchEntryV1): void {
    if (entry.observerCount < 1) throw new Error('System Record observer underflow');
    entry.observerCount -= 1;
    this.#waitingCallers -= 1;
    this.#disposeIfIdle(entry);
  }

  retainSource(entry: FetchEntryV1, source: SystemRecordRetainedSourceV1): void {
    if (entry.phase.state !== 'pending') {
      source.release();
      throw new Error('System Record source retained outside the pending phase');
    }
    entry.phase = Object.freeze({ state: 'retained', source });
    this.#retainedPayloadBytes += source.artifact.canonicalBytes.byteLength;
  }

  settleFailure(entry: FetchEntryV1): void {
    if (entry.phase.state !== 'pending') return;
    entry.phase = Object.freeze({ state: 'failed' });
    this.#remove(entry);
  }

  deliverLease(
    entry: FetchEntryV1,
    source: SystemRecordRetainedSourceV1,
  ): SystemRecordExactFetchResultV1 {
    if (entry.phase.state !== 'retained' || entry.phase.source !== source) {
      throw new Error('System Record lease source is not retained by its entry');
    }
    const payloadBytes = source.artifact.canonicalBytes.byteLength;
    const reservation = this.#byteAdmission.tryReserve(payloadBytes);
    if (reservation === null) {
      return Object.freeze({ outcome: 'capacity', wireBytes: source.wireBytes });
    }
    let artifact: ReturnType<typeof cloneSystemRecordArtifactV1>;
    try {
      artifact = cloneSystemRecordArtifactV1(source.artifact);
    } catch {
      reservation.release();
      return Object.freeze({ outcome: 'capacity', wireBytes: source.wireBytes });
    }
    entry.leaseCount += 1;
    this.#activeLeases += 1;
    this.#retainedPayloadBytes += payloadBytes;
    let released = false;
    return Object.freeze({
      outcome: 'ok',
      lease: Object.freeze({
        artifact,
        wireBytes: source.wireBytes,
        release: () => {
          if (released) return;
          released = true;
          entry.leaseCount -= 1;
          this.#activeLeases -= 1;
          this.#retainedPayloadBytes -= payloadBytes;
          reservation.release();
          this.#disposeIfIdle(entry);
        },
      }),
    });
  }

  abort(
    entry: FetchEntryV1,
    reason: SystemRecordRequesterResetReasonV1,
    error: Error,
  ): void {
    const phase = entry.phase;
    if (phase.state !== 'pending' || phase.controller.signal.aborted) return;
    phase.abortReason = reason;
    phase.controller.abort(error);
  }

  close(): void {
    for (const entry of this.#entries.values()) {
      this.abort(entry, 'closed', new Error('system-record requester closed'));
    }
  }

  #disposeIfIdle(entry: FetchEntryV1): void {
    if (entry.observerCount !== 0 || entry.leaseCount !== 0) return;
    const phase = entry.phase;
    if (phase.state === 'pending') {
      this.abort(entry, 'cancelled', new Error('system-record requester has no callers'));
      return;
    }
    if (phase.state !== 'retained') return;
    entry.phase = Object.freeze({ state: 'disposed' });
    this.#remove(entry);
    this.#retainedPayloadBytes -= phase.source.artifact.canonicalBytes.byteLength;
    phase.source.release();
  }

  #remove(entry: FetchEntryV1): void {
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
  }
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
  const registry = new ExactFetchRegistryV1(options.byteAdmission);
  let started = 0;
  let joined = 0;
  let completed = 0;
  let activeStream: 0 | 1 = 0;
  let peakActiveStream: 0 | 1 = 0;
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
    let entry = registry.get(key);
    if (entry !== undefined) {
      if (registry.pendingAborted(entry)) {
        return Object.freeze({ outcome: 'busy', wireBytes: 0 });
      }
      // The first observer owns the transfer; the frozen limit counts followers.
      if (registry.participantCount(entry) >= maxWaitersPerDigest + 1) {
        return Object.freeze({ outcome: 'waiter-limit', wireBytes: 0 });
      }
      joined += 1;
      return subscribe(entry, signal);
    }
    if (registry.size >= maxPendingDigests) {
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
    entry = registry.create(
      key,
      {
        state: 'pending',
        controller: new AbortController(),
        transfer,
      },
    );
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
    registry.addObserver(entry);
    let observing = true;
    const releaseObserver = () => {
      if (!observing) return;
      observing = false;
      registry.releaseObserver(entry);
    };
    signal.addEventListener('abort', releaseObserver, { once: true });
    if (signal.aborted) {
      releaseObserver();
      signal.throwIfAborted();
    }
    try {
      const phase = registry.snapshot(entry);
      if (phase.state === 'retained') {
        return registry.deliverLease(entry, phase.source);
      }
      if (phase.state !== 'pending') {
        return Object.freeze({ outcome: 'busy', wireBytes: 0 });
      }
      const shared = await raceSystemRecordAbortV1(phase.transfer, signal);
      return shared.state === 'retained'
        ? registry.deliverLease(entry, shared.source)
        : shared.result;
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
    const pending = registry.snapshot(entry);
    if (pending.state !== 'pending') {
      throw new Error('System Record transfer started outside the pending phase');
    }
    let exchange: SystemRecordRequesterExchangeV1 | undefined;
    let wireBytes = 0;
    const timeout = setTimeout(
      () => registry.abort(
        entry,
        'deadline',
        new Error('system-record requester deadline exceeded'),
      ),
      timeoutMs,
    );
    timeout.unref?.();
    let settlement: SystemRecordRequesterSettlementV1;
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
        registry.retainSource(entry, retained.retained);
        settlement = Object.freeze({ state: 'retained', source: retained.retained });
      } else {
        settlement = Object.freeze({ state: 'failed', result: retained });
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
      settlement = Object.freeze({
        state: 'failed',
        result: Object.freeze({ outcome, wireBytes }),
      });
    } finally {
      clearTimeout(timeout);
      frameReservation.release();
      streamPermit.release();
      activeStream = 0;
      completed += 1;
    }
    if (settlement.state === 'failed') registry.settleFailure(entry);
    return settlement;
  }

  function stats(): SystemRecordRequesterStatsV1 {
    return Object.freeze({
      started,
      joined,
      completed,
      pendingDigests: registry.size,
      waitingCallers: registry.waitingCallers,
      activeLeases: registry.activeLeases,
      activeStream,
      peakActiveStream,
      queuedStreams: 0,
      retainedPayloadBytes: registry.retainedPayloadBytes,
      closed,
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    registry.close();
  }
}

function boundedPositive(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be in 1..${maximum}`);
  }
  return value;
}
