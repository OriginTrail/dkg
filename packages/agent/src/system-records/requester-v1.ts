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
import { raceSystemRecordAbortV1 } from './resource-admission-v1-internal.js';

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
  readonly pendingSignal: AbortSignal;
  readonly participantCount: number;
  readonly pendingAborted: boolean;
  subscribe(signal: AbortSignal): Promise<SystemRecordExactFetchResultV1>;
  completeRetained(source: SystemRecordRetainedSourceV1): SystemRecordRequesterSettlementV1;
  completeFailure(result: SystemRecordRequesterFailureV1): SystemRecordRequesterSettlementV1;
  abort(reason: SystemRecordRequesterResetReasonV1, error: Error): void;
  resetReason(): SystemRecordRequesterResetReasonV1;
  close(): void;
  accounting(): Readonly<{
    waitingCallers: number;
    activeLeases: number;
    retainedPayloadBytes: number;
  }>;
}

class ExactFetchRegistryV1 {
  readonly #entries = new Map<string, FetchEntryV1>();
  readonly #tracked = new Set<FetchEntryV1>();
  readonly #byteAdmission: SystemRecordRequesterByteAdmissionV1;

  constructor(byteAdmission: SystemRecordRequesterByteAdmissionV1) {
    this.#byteAdmission = byteAdmission;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): FetchEntryV1 | undefined {
    return this.#entries.get(key);
  }

  create(key: string, pending: PendingFetchPhaseV1): FetchEntryV1 {
    const entry = new ExactFetchEntryV1(key, pending, this.#byteAdmission, this);
    this.#entries.set(key, entry);
    this.#tracked.add(entry);
    return entry;
  }

  stats(): Readonly<{
    waitingCallers: number;
    activeLeases: number;
    retainedPayloadBytes: number;
  }> {
    let waitingCallers = 0;
    let activeLeases = 0;
    let retainedPayloadBytes = 0;
    for (const entry of this.#tracked) {
      const accounting = entry.accounting();
      waitingCallers += accounting.waitingCallers;
      activeLeases += accounting.activeLeases;
      retainedPayloadBytes += accounting.retainedPayloadBytes;
    }
    return Object.freeze({ waitingCallers, activeLeases, retainedPayloadBytes });
  }

  close(): void {
    for (const entry of this.#tracked) entry.close();
  }

  unpublish(entry: FetchEntryV1): void {
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
  }

  dispose(entry: FetchEntryV1): void {
    this.unpublish(entry);
    this.#tracked.delete(entry);
  }
}

class ExactFetchEntryV1 implements FetchEntryV1 {
  readonly key: string;
  readonly #byteAdmission: SystemRecordRequesterByteAdmissionV1;
  readonly #registry: ExactFetchRegistryV1;
  #phase: FetchPhaseV1;
  #observerCount = 0;
  #leaseCount = 0;
  #retainedPayloadBytes = 0;
  #lastResetReason: SystemRecordRequesterResetReasonV1 = 'cancelled';

  constructor(
    key: string,
    pending: PendingFetchPhaseV1,
    byteAdmission: SystemRecordRequesterByteAdmissionV1,
    registry: ExactFetchRegistryV1,
  ) {
    this.key = key;
    this.#phase = pending;
    this.#byteAdmission = byteAdmission;
    this.#registry = registry;
  }

  get pendingSignal(): AbortSignal {
    const phase = this.#phase;
    if (phase.state !== 'pending') throw new Error('System Record entry is not pending');
    return phase.controller.signal;
  }

  get participantCount(): number {
    return this.#observerCount + this.#leaseCount;
  }

  get pendingAborted(): boolean {
    return this.#phase.state === 'pending' && this.#phase.controller.signal.aborted;
  }

  async subscribe(signal: AbortSignal): Promise<SystemRecordExactFetchResultV1> {
    this.#observerCount += 1;
    let observing = true;
    const releaseObserver = () => {
      if (!observing) return;
      observing = false;
      this.#observerCount -= 1;
      this.#disposeIfIdle();
    };
    signal.addEventListener('abort', releaseObserver, { once: true });
    if (signal.aborted) {
      releaseObserver();
      signal.throwIfAborted();
    }
    try {
      const phase = this.#phase;
      if (phase.state === 'retained') return this.#deliverLease(phase.source);
      if (phase.state !== 'pending') {
        return Object.freeze({ outcome: 'busy', wireBytes: 0 });
      }
      const shared = await raceSystemRecordAbortV1(phase.transfer, signal);
      return shared.state === 'retained'
        ? this.#deliverLease(shared.source)
        : shared.result;
    } finally {
      signal.removeEventListener('abort', releaseObserver);
      releaseObserver();
    }
  }

  completeRetained(source: SystemRecordRetainedSourceV1): SystemRecordRequesterSettlementV1 {
    if (this.#phase.state !== 'pending') {
      source.release();
      throw new Error('System Record source retained outside the pending phase');
    }
    this.#phase = Object.freeze({ state: 'retained', source });
    this.#retainedPayloadBytes += source.artifact.canonicalBytes.byteLength;
    return Object.freeze({ state: 'retained', source });
  }

  completeFailure(result: SystemRecordRequesterFailureV1): SystemRecordRequesterSettlementV1 {
    if (this.#phase.state !== 'pending') {
      throw new Error('System Record failure completed outside the pending phase');
    }
    this.#phase = Object.freeze({ state: 'failed' });
    this.#registry.unpublish(this);
    this.#disposeIfIdle();
    return Object.freeze({ state: 'failed', result });
  }

  abort(reason: SystemRecordRequesterResetReasonV1, error: Error): void {
    const phase = this.#phase;
    if (phase.state !== 'pending' || phase.controller.signal.aborted) return;
    phase.abortReason = reason;
    this.#lastResetReason = reason;
    phase.controller.abort(error);
  }

  resetReason(): SystemRecordRequesterResetReasonV1 {
    return this.#lastResetReason;
  }

  close(): void {
    this.abort('closed', new Error('system-record requester closed'));
  }

  accounting(): Readonly<{
    waitingCallers: number;
    activeLeases: number;
    retainedPayloadBytes: number;
  }> {
    return Object.freeze({
      waitingCallers: this.#observerCount,
      activeLeases: this.#leaseCount,
      retainedPayloadBytes: this.#retainedPayloadBytes,
    });
  }

  #deliverLease(source: SystemRecordRetainedSourceV1): SystemRecordExactFetchResultV1 {
    if (this.#phase.state !== 'retained' || this.#phase.source !== source) {
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
    this.#leaseCount += 1;
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
          this.#leaseCount -= 1;
          this.#retainedPayloadBytes -= payloadBytes;
          reservation.release();
          this.#disposeIfIdle();
        },
      }),
    });
  }

  #disposeIfIdle(): void {
    if (this.#observerCount !== 0 || this.#leaseCount !== 0) return;
    const phase = this.#phase;
    if (phase.state === 'pending') {
      this.abort('cancelled', new Error('system-record requester has no callers'));
      return;
    }
    if (phase.state === 'retained') {
      this.#retainedPayloadBytes -= phase.source.artifact.canonicalBytes.byteLength;
      phase.source.release();
    }
    if (phase.state === 'retained' || phase.state === 'failed') {
      this.#phase = Object.freeze({ state: 'disposed' });
      this.#registry.dispose(this);
    }
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
      if (entry.pendingAborted) {
        return Object.freeze({ outcome: 'busy', wireBytes: 0 });
      }
      // The first observer owns the transfer; the frozen limit counts followers.
      if (entry.participantCount >= maxWaitersPerDigest + 1) {
        return Object.freeze({ outcome: 'waiter-limit', wireBytes: 0 });
      }
      joined += 1;
      return entry.subscribe(signal);
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
    return entry.subscribe(signal);
  }

  async function run(
    entry: FetchEntryV1,
    request: SystemRecordRequestHeaderV1,
    streamPermit: SystemRecordRequesterPermitV1,
    frameReservation: SystemRecordRequesterByteReservationV1,
  ): Promise<SystemRecordRequesterSettlementV1> {
    const pendingSignal = entry.pendingSignal;
    let exchange: SystemRecordRequesterExchangeV1 | undefined;
    let wireBytes = 0;
    const timeout = setTimeout(
      () => entry.abort(
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
        signal: pendingSignal,
        resetReason: () => entry.resetReason(),
      });
      const transfer = await exchangeSystemRecordResponseV1({
        request,
        exchange,
        frameReservation,
        signal: pendingSignal,
      });
      wireBytes = transfer.wireBytes;
      const retained = retainVerifiedSystemRecordResponseV1({
        request,
        transfer,
        decodeAdmission: options.decodeAdmission,
        byteAdmission: options.byteAdmission,
      });
      if (retained.outcome === 'ok') {
        settlement = entry.completeRetained(retained.retained);
      } else {
        settlement = Object.freeze({ state: 'failed', result: retained });
      }
    } catch (error) {
      if (error instanceof SystemRecordRequesterTransferError) {
        wireBytes = error.wireBytes;
      }
      const outcome = error instanceof InvalidSystemRecordResponseError
        ? 'invalid-response'
        : pendingSignal.aborted
          ? entry.resetReason() === 'closed'
            ? 'closed'
            : entry.resetReason() === 'deadline'
              ? 'deadline'
              : 'transport'
          : 'transport';
      try {
        exchange?.reset(
          outcome === 'invalid-response'
            ? 'invalid-response'
            : pendingSignal.aborted ? entry.resetReason() : outcome,
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
    return settlement.state === 'failed'
      ? entry.completeFailure(settlement.result)
      : settlement;
  }

  function stats(): SystemRecordRequesterStatsV1 {
    const entryStats = registry.stats();
    return Object.freeze({
      started,
      joined,
      completed,
      pendingDigests: registry.size,
      waitingCallers: entryStats.waitingCallers,
      activeLeases: entryStats.activeLeases,
      activeStream,
      peakActiveStream,
      queuedStreams: 0,
      retainedPayloadBytes: entryStats.retainedPayloadBytes,
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
