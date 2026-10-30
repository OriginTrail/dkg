// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncCheckpointScope } from '../checkpoint/state.js';

export interface DurableMetaContinuationState {
  checkpointKey: string;
  quads: Quad[];
  quadRawOffsets?: number[];
  bytesReceived: number;
  nextOffset: number;
  rawNextOffset: number;
}

/** One graph-owner-private retained META prefix across bounded recovery slices. */
export interface DurableMetaContinuation {
  readonly requesterScope: SyncCheckpointScope;
  state?: DurableMetaContinuationState;
}

