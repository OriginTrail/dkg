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

interface FetchEntryAccountingV1 {
  observerDelta(delta: 1 | -1): void;
  leaseDelta(delta: 1 | -1): void;
  retainedBytesDelta(delta: number): void;
  remove(entry: FetchEntryV1): void;
}

class FetchEntryV1 {
  readonly key: string;
  #phase: FetchPhaseV1;
  #observerCount = 0;
  #leaseCount = 0;
  readonly #accounting: FetchEntryAccountingV1;

  constructor(
    key: string,
    pending: PendingFetchPhaseV1,
    accounting: FetchEntryAccountingV1,
  ) {
    this.key = key;
    this.#phase = pending;
    this.#accounting = accounting;
  }

  get participantCount(): number {
    return this.#observerCount + this.#leaseCount;
  }

  get pendingAborted(): boolean {
    return this.#phase.state === 'pending' && this.#phase.controller.signal.aborted;
  }

  snapshot(): FetchPhaseV1 {
    return this.#phase;
  }

  addObserver(): void {
    this.#observerCount += 1;
    this.#accounting.observerDelta(1);
  }

  releaseObserver(): void {
    if (this.#observerCount < 1) throw new Error('System Record observer underflow');
    this.#observerCount -= 1;
    this.#accounting.observerDelta(-1);
    this.#disposeIfIdle();
  }

  retainSource(source: SystemRecordRetainedSourceV1): void {
    if (this.#phase.state !== 'pending') {
      source.release();
      throw new Error('System Record source retained outside the pending phase');
    }
    this.#phase = Object.freeze({ state: 'retained', source });
    this.#accounting.retainedBytesDelta(source.artifact.canonicalBytes.byteLength);
  }

  settleFailure(): void {
    if (this.#phase.state !== 'pending') return;
    this.#phase = Object.freeze({ state: 'failed' });
    this.#accounting.remove(this);
  }

  deliverLease(
    source: SystemRecordRetainedSourceV1,
    byteAdmission: SystemRecordRequesterByteAdmissionV1,
  ): SystemRecordExactFetchResultV1 {
    if (this.#phase.state !== 'retained' || this.#phase.source !== source) {
      throw new Error('System Record lease source is not retained by its entry');
    }
    const payloadBytes = source.artifact.canonicalBytes.byteLength;
    const reservation = byteAdmission.tryReserve(payloadBytes);
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
    this.#accounting.leaseDelta(1);
    this.#accounting.retainedBytesDelta(payloadBytes);
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
          this.#accounting.leaseDelta(-1);
          this.#accounting.retainedBytesDelta(-payloadBytes);
          reservation.release();
          this.#disposeIfIdle();
        },
      }),
    });
  }

  abort(reason: SystemRecordRequesterResetReasonV1, error: Error): void {
    const phase = this.#phase;
    if (phase.state !== 'pending' || phase.controller.signal.aborted) return;
    phase.abortReason = reason;
    phase.controller.abort(error);
  }

  close(): void {
    this.abort('closed', new Error('system-record requester closed'));
  }

  #disposeIfIdle(): void {
    if (this.#observerCount !== 0 || this.#leaseCount !== 0) return;
    const phase = this.#phase;
    if (phase.state === 'pending') {
      this.abort('cancelled', new Error('system-record requester has no callers'));
      return;
    }
    if (phase.state !== 'retained') return;
    this.#phase = Object.freeze({ state: 'disposed' });
    this.#accounting.remove(this);
    this.#accounting.retainedBytesDelta(-phase.source.artifact.canonicalBytes.byteLength);
    phase.source.release();
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
  const entryAccounting: FetchEntryAccountingV1 = {
    observerDelta(delta) {
      waitingCallers += delta;
    },
    leaseDelta(delta) {
      activeLeases += delta;
    },
    retainedBytesDelta(delta) {
      retainedPayloadBytes += delta;
    },
    remove(entry) {
      if (entries.get(entry.key) === entry) entries.delete(entry.key);
    },
  };

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
      if (entry.pendingAborted) {
        return Object.freeze({ outcome: 'busy', wireBytes: 0 });
      }
      // The first observer owns the transfer; the frozen limit counts followers.
      if (entry.participantCount >= maxWaitersPerDigest + 1) {
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
    entry = new FetchEntryV1(
      key,
      {
        state: 'pending',
        controller: new AbortController(),
        transfer,
      },
      entryAccounting,
    );
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
    entry.addObserver();
    let observing = true;
    const releaseObserver = () => {
      if (!observing) return;
      observing = false;
      entry.releaseObserver();
    };
    signal.addEventListener('abort', releaseObserver, { once: true });
    if (signal.aborted) {
      releaseObserver();
      signal.throwIfAborted();
    }
    try {
      const phase = entry.snapshot();
      if (phase.state === 'retained') {
        return entry.deliverLease(phase.source, options.byteAdmission);
      }
      if (phase.state !== 'pending') {
        return Object.freeze({ outcome: 'busy', wireBytes: 0 });
      }
      const shared = await raceSystemRecordAbortV1(phase.transfer, signal);
      return shared.state === 'retained'
        ? entry.deliverLease(shared.source, options.byteAdmission)
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
    const pending = entry.snapshot();
    if (pending.state !== 'pending') {
      throw new Error('System Record transfer started outside the pending phase');
    }
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
        entry.retainSource(retained.retained);
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
    if (settlement.state === 'failed') entry.settleFailure();
    return settlement;
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
      entry.close();
    }
  }
}

function boundedPositive(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be in 1..${maximum}`);
  }
  return value;
}
