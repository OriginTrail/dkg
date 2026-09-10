import type { ChainResetWipeResult } from '../src/daemon/chain-reset-wipe.js';

// Explicit constructions exercise every supported status and its effect data.
const statuses: ChainResetWipeResult[] = [
  { status: 'inactive', attempted: false, requiresStoreRetag: false, prevMarker: null, removedFiles: [], backedUpFiles: [], failedFiles: [] },
  { status: 'steady', attempted: false, requiresStoreRetag: false, prevMarker: 'same', removedFiles: [], backedUpFiles: [], failedFiles: [] },
  { status: 'skipped', attempted: false, requiresStoreRetag: false, prevMarker: 'old', removedFiles: [], backedUpFiles: [], failedFiles: [] },
  { status: 'completed', attempted: true, requiresStoreRetag: false, prevMarker: 'old', removedFiles: ['sampling.wal'], backedUpFiles: [], failedFiles: [] },
  { status: 'incomplete', attempted: true, requiresStoreRetag: true, prevMarker: 'old', removedFiles: [], backedUpFiles: [], failedFiles: [{ file: 'store.nq', error: 'denied' }] },
  { status: 'marker-write-failed', attempted: true, requiresStoreRetag: true, prevMarker: 'old', removedFiles: ['sampling.wal'], backedUpFiles: [], failedFiles: [], markerError: 'denied' },
];
void statuses;
// @ts-expect-error Conflicting boolean states are no longer representable.
const conflicting: ChainResetWipeResult = { status: 'inactive', attempted: false, requiresStoreRetag: false, prevMarker: null, removedFiles: [], backedUpFiles: [], failedFiles: [], wiped: true, skipped: true };
// @ts-expect-error An inactive result cannot report removed files.
const inactiveWithEffects: ChainResetWipeResult = { status: 'inactive', attempted: false, requiresStoreRetag: false, prevMarker: null, removedFiles: ['store.nq'], backedUpFiles: [], failedFiles: [] };
// @ts-expect-error A matching marker is necessarily present.
const steadyWithoutMarker: ChainResetWipeResult = { status: 'steady', attempted: false, requiresStoreRetag: false, prevMarker: null, removedFiles: [], backedUpFiles: [], failedFiles: [] };
void conflicting; void inactiveWithEffects; void steadyWithoutMarker;

// @ts-expect-error A completed wipe cannot contain failed cleanup targets.
const completedWithFailures: ChainResetWipeResult = { status: 'completed', attempted: true, requiresStoreRetag: false, prevMarker: null, removedFiles: [], backedUpFiles: [], failedFiles: [{ file: 'store.nq', error: 'denied' }] };
// @ts-expect-error Incomplete cleanup requires at least one failure.
const incompleteWithoutFailure: ChainResetWipeResult = { status: 'incomplete', attempted: true, requiresStoreRetag: false, prevMarker: null, removedFiles: [], backedUpFiles: [], failedFiles: [] };
// @ts-expect-error A marker-write failure must carry its persistence error.
const missingMarkerError: ChainResetWipeResult = { status: 'marker-write-failed', attempted: true, requiresStoreRetag: true, prevMarker: null, removedFiles: [], backedUpFiles: [], failedFiles: [] };
const contradictoryCompletion: { status: 'completed'; attempted: true; requiresStoreRetag: false; prevMarker: null; removedFiles: []; backedUpFiles: []; failedFiles: []; markerError: string } = {
  status: 'completed', attempted: true, requiresStoreRetag: false, prevMarker: null, removedFiles: [], backedUpFiles: [], failedFiles: [], markerError: 'write failed',
};
// @ts-expect-error Widened variables cannot represent a marker-write failure as completed.
const completedWithMarkerError: ChainResetWipeResult = contradictoryCompletion;
void completedWithFailures; void incompleteWithoutFailure; void missingMarkerError; void completedWithMarkerError;
