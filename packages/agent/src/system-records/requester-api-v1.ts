// SPDX-License-Identifier: Apache-2.0

import type {
  Digest32V1,
  NetworkIdV1,
  SystemRecordRequestHeaderV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type {
  SystemRecordArtifactLookupV1,
  SystemRecordArtifactV1,
} from './artifact-v1.js';
import type {
  SystemRecordByteAdmissionV1,
  SystemRecordByteReservationV1,
  SystemRecordPermitAdmissionV1,
  SystemRecordPermitV1,
} from './resource-admission-v1-internal.js';

type SystemRecordExactObjectKindV1 = Extract<
  SystemRecordRequestHeaderV1,
  Readonly<{ operation: 'get-bundle' | 'get-control-object' }>
>['objectKind'];

export type SystemRecordExactArtifactLookupV1 =
  | Extract<SystemRecordArtifactLookupV1, Readonly<{ type: 'inventory-object' }>>
  | Readonly<{
    type: 'object';
    objectKind: SystemRecordExactObjectKindV1;
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

/** Supplied by the one lifecycle-owned aggregate accountant; it never queues. */
export type SystemRecordRequesterByteReservationV1 = SystemRecordByteReservationV1;
export type SystemRecordRequesterByteAdmissionV1 = SystemRecordByteAdmissionV1;

export type SystemRecordRequesterPermitV1 = SystemRecordPermitV1;
/** Shared process-wide, nonqueued requester or decoder admission. */
export type SystemRecordRequesterAdmissionV1 = SystemRecordPermitAdmissionV1;

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
  /** Exact coordinates with an in-flight transfer or a retained source lease. */
  readonly trackedDigests: number;
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
    signal: AbortSignal,
  ): Promise<SystemRecordExactFetchResultV1>;
  stats(): SystemRecordRequesterStatsV1;
  close(): void;
}

export interface SystemRecordRequesterLimitsV1 {
  /** Exact coordinates retained or in flight; may only lower the protocol maximum. */
  readonly maxTrackedDigests?: number;
  /** Followers admitted behind one exact-coordinate leader; may only lower the protocol maximum. */
  readonly maxWaitersPerDigest?: number;
}

export interface CreateSystemRecordRequesterOptionsV1 {
  readonly networkId: NetworkIdV1;
  /** Lifecycle-owned provider selection and transport opening for a leader transfer. */
  readonly openExchange: (signal: AbortSignal) => Promise<SystemRecordRequesterExchangeV1>;
  readonly byteAdmission: SystemRecordRequesterByteAdmissionV1;
  readonly streamAdmission: SystemRecordRequesterAdmissionV1;
  readonly decodeAdmission: SystemRecordRequesterAdmissionV1;
  readonly requestId?: () => string;
  readonly timeoutMs?: number;
  /** Lifecycle-owned immutable policy; omitted values use the protocol maxima. */
  readonly limits?: Readonly<SystemRecordRequesterLimitsV1>;
}
