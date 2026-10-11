// SPDX-License-Identifier: Apache-2.0

/**
 * One transport decision for a bounded exact-recovery selection.
 * `legacy` keeps conservative/unknown footprints on the ordinary wire.
 * `stream-preferred` permits fallback before START within ordinary bounds.
 * `stream-required` never replays an enlarged stream selection through legacy.
 */
export type ExactRecoveryTransportMode = 'legacy' | 'stream-preferred' | 'stream-required';

/**
 * What an exact-batch stream exchange established about the peer as a stream
 * source. `complete`: it delivered everything asked. The other two settled
 * incomplete for a reason that says nothing about the peer's data: it answered
 * that it is busy, or the stream itself broke. Absent when the stream was not
 * used and for every other outcome (another refusal, an asset this node
 * rejected or could not store, a cancellation).
 */
export type ExactBatchStreamOutcome = 'complete' | 'responder-busy' | 'stream-interrupted';

/** The two outcomes that leave the peer worth asking again. */
export type ExactBatchStreamSetback = Exclude<ExactBatchStreamOutcome, 'complete'>;
