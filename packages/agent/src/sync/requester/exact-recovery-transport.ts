// SPDX-License-Identifier: Apache-2.0

/**
 * One transport decision for a bounded exact-recovery selection.
 * `legacy` keeps conservative/unknown footprints on the ordinary wire.
 * `stream-preferred` permits fallback before START within ordinary bounds.
 * `stream-required` never replays an enlarged stream selection through legacy.
 */
export type ExactRecoveryTransportMode = 'legacy' | 'stream-preferred' | 'stream-required';
