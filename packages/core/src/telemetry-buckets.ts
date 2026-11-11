// SPDX-License-Identifier: Apache-2.0

/** Histogram bucket boundaries for the instruments of `telemetry-api.ts`. */

/** Duration buckets (ms) for operation-level histograms. */
export const OP_DURATION_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000];
/** Duration buckets (ms) for chain RPC histograms (faster floor). */
export const RPC_DURATION_BUCKETS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 120000];
/** Retained/process bytes from 1 MiB through 4 GiB. */
export const BYTE_BUCKETS = [
  1024 * 1024,
  4 * 1024 * 1024,
  16 * 1024 * 1024,
  32 * 1024 * 1024,
  64 * 1024 * 1024,
  128 * 1024 * 1024,
  256 * 1024 * 1024,
  512 * 1024 * 1024,
  1024 * 1024 * 1024,
  2 * 1024 * 1024 * 1024,
  4 * 1024 * 1024 * 1024,
];
export const QUAD_COUNT_BUCKETS = [100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
export const PAGE_COUNT_BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000];
/** Graphs one query routes per asset. */
export const GRAPH_COUNT_BUCKETS = [1, 10, 100, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000];
/**
 * Duration buckets (ms) for a whole context-graph catch-up job, out to ~30 min.
 *
 * `OP_DURATION_BUCKETS` stops at 120 s, but observed foreground catch-up jobs ran
 * 305 s and 382 s — both would land in the `+Inf` overflow and become unresolvable.
 * Every measured job must fall in a *finite* bucket.
 */
export const CATCHUP_DURATION_BUCKETS = [
  1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 240_000,
  300_000, 420_000, 600_000, 900_000, 1_800_000,
];
/**
 * Duration buckets (ms) for a single logical sync operation's *active* occupancy
 * (peer wait + decode + verification + store commit). Floor is finer than
 * `OP_DURATION_BUCKETS` because cheap cache-warm operations cluster below 50 ms.
 */
export const SYNC_OPERATION_DURATION_BUCKETS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000,
  10_000, 30_000, 60_000, 120_000, 300_000,
];

/** ms; async admission: 5 ms to 60 s (the share route waits up to 20 s for write readiness). */
export const ADMISSION_LATENCY_BUCKETS = [5, 25, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 60000];
/** ms; heartbeat and `claimNext` waits behind the share mutex: 1 ms to 2 min. */
export const QUEUE_WAIT_BUCKETS = [1, 5, 25, 100, 500, 1000, 2500, 5000, 15000, 60000, 120000];
/** ms; publisher pick-up and claim-to-finish: 100 ms to 1 h. */
export const PICKUP_BUCKETS = [100, 500, 1000, 5000, 15000, 60000, 300000, 900000, 1800000, 3600000];
/** ms; one read-graph check: a sampled probe in milliseconds, a full check up to half an hour. */
export const READ_GRAPH_CHECK_DURATION_BUCKETS = [10, 50, 100, 500, 1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000];
