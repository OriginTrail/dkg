// SPDX-License-Identifier: Apache-2.0

import type {
  Digest32V1,
  NetworkIdV1,
  SystemRecordObjectKindV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type {
  SystemRecordArtifactLookupV1,
  SystemRecordArtifactV1,
} from './artifact-v1.js';

type SystemRecordExactControlObjectKindV1 = Exclude<
  SystemRecordObjectKindV1,
  'root-descriptor' | 'inventory-internal' | 'inventory-leaf'
>;

export type SystemRecordExactArtifactLookupV1 =
  | Extract<SystemRecordArtifactLookupV1, Readonly<{ type: 'inventory-object' }>>
  | Readonly<{
    type: 'object';
    objectKind: SystemRecordExactControlObjectKindV1;
    objectDigest: Digest32V1;
  }>;

export interface SystemRecordRequesterExchangeV1 {
  writeRequestFrame(frame: Uint8Array, signal: AbortSignal): Promise<void>;
  readResponseFrame(maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
  reset(reason: SystemRecordRequesterResetReasonV1): void;
}

export type SystemRecordRequesterResetReasonV1 =
  | 'deadline'
  | 'invalid-response'
  | 'transport'
  | 'cancelled'
  | 'closed';

export interface SystemRecordRequesterByteReservationV1 {
  shrinkTo(bytes: number): void;
  release(): void;
}

/** Supplied by the one lifecycle-owned aggregate accountant; it never queues. */
export interface SystemRecordRequesterByteAdmissionV1 {
  tryReserve(bytes: number): SystemRecordRequesterByteReservationV1 | null;
}

export interface SystemRecordRequesterPermitV1 {
  release(): void;
}

/** Shared process-wide, nonqueued requester or decoder admission. */
export interface SystemRecordRequesterAdmissionV1 {
  tryAcquire(): SystemRecordRequesterPermitV1 | null;
}

export interface SystemRecordExactFetchLeaseV1 {
  readonly artifact: SystemRecordArtifactV1;
  readonly wireBytes: number;
  release(): void;
}

export type SystemRecordExactFetchResultV1 =
  | Readonly<{ outcome: 'ok'; lease: SystemRecordExactFetchLeaseV1 }>
  | Readonly<{
    outcome:
      | 'not-found'
      | 'unsupported'
      | 'remote-busy'
      | 'remote-error'
      | 'busy'
      | 'capacity'
      | 'waiter-limit'
      | 'deadline'
      | 'invalid-response'
      | 'transport'
      | 'closed';
    wireBytes: number;
  }>;

export interface SystemRecordRequesterStatsV1 {
  readonly started: number;
  readonly joined: number;
  readonly completed: number;
  readonly pendingDigests: number;
  readonly waitingCallers: number;
  readonly activeLeases: number;
  readonly activeStream: 0 | 1;
  readonly peakActiveStream: 0 | 1;
  readonly queuedStreams: 0;
  readonly retainedPayloadBytes: number;
  readonly closed: boolean;
}

export interface SystemRecordRequesterV1 {
  fetch(
    lookup: SystemRecordExactArtifactLookupV1,
    openExchange: (signal: AbortSignal) => Promise<SystemRecordRequesterExchangeV1>,
    signal: AbortSignal,
  ): Promise<SystemRecordExactFetchResultV1>;
  stats(): SystemRecordRequesterStatsV1;
  close(): void;
}

export interface CreateSystemRecordRequesterOptionsV1 {
  readonly networkId: NetworkIdV1;
  readonly byteAdmission: SystemRecordRequesterByteAdmissionV1;
  readonly streamAdmission: SystemRecordRequesterAdmissionV1;
  readonly decodeAdmission: SystemRecordRequesterAdmissionV1;
  readonly requestId?: () => string;
  readonly timeoutMs?: number;
  /** Test seams may lower, never raise, the frozen protocol limits. */
  readonly maxPendingDigests?: number;
  readonly maxWaitersPerDigest?: number;
}
