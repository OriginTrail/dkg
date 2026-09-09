import type { ChainResetWipeResult } from '../src/daemon/chain-reset-wipe.js';

// Explicit constructions exercise every supported status and its effect data.
const statuses: ChainResetWipeResult[] = [
  { status: 'inactive', prevMarker: null, removedFiles: [], backedUpFiles: [], failedFiles: [] },
  { status: 'steady', prevMarker: 'same', removedFiles: [], backedUpFiles: [], failedFiles: [] },
  { status: 'skipped', prevMarker: 'old', removedFiles: [], backedUpFiles: [], failedFiles: [] },
  { status: 'wiped', prevMarker: 'old', removedFiles: ['sampling.wal'], backedUpFiles: [], failedFiles: [] },
];
void statuses;
// @ts-expect-error Conflicting boolean states are no longer representable.
const conflicting: ChainResetWipeResult = { wiped: true, skipped: true, prevMarker: null, removedFiles: [], backedUpFiles: [], failedFiles: [] };
// @ts-expect-error An inactive result cannot report removed files.
const inactiveWithEffects: ChainResetWipeResult = { status: 'inactive', prevMarker: null, removedFiles: ['store.nq'], backedUpFiles: [], failedFiles: [] };
// @ts-expect-error A matching marker is necessarily present.
const steadyWithoutMarker: ChainResetWipeResult = { status: 'steady', prevMarker: null, removedFiles: [], backedUpFiles: [], failedFiles: [] };
void conflicting; void inactiveWithEffects; void steadyWithoutMarker;
