// SPDX-License-Identifier: Apache-2.0
import { RPC_READ_STALL_TIMEOUT_MS, RPC_SECURITY_GATE_ATTEMPT_TIMEOUT_MS, RPC_LOG_SCAN_TIMEOUT_MS } from './evm-adapter-constants.js';

/**
 * Named per-attempt timeout policy for a failover read: callers pick an intent,
 * not a millisecond value. The exact cap each policy yields is in
 * {@link resolveCapMs}.
 *   - `pointRead`           — a single `eth_call` / point provider read.
 *   - `wideLogScan`         — a multi-thousand-block `eth_getLogs` scan.
 *   - `durablePagedLogScan` — a checkpointed scan whose physical requests
 *     carry their own deadlines, so the complete projection is uncapped.
 *   - `watchdogPointRead`   — a background point read that must not wedge a
 *     one-RPC node.
 *   - `watchdogWideLogScan` — a background log scan that must not wedge a
 *     one-RPC node.
 *   - `failOpenFundingRead` — a fail-open funding/allowance read that must never
 *     stall selection (capped on EVERY attempt, including single-RPC).
 *   - `securityGatePointRead` — a live authorization read whose multi-RPC
 *     attempts must fail over inside the caller's 2.5s fail-closed deadline.
 */
export type ReadPolicy =
  | 'pointRead'
  | 'wideLogScan'
  | 'durablePagedLogScan'
  | 'watchdogPointRead'
  | 'watchdogWideLogScan'
  | 'failOpenFundingRead'
  | 'securityGatePointRead';

/**
 * The timeout-policy matrix — the per-attempt cap each named policy yields:
 *
 *   | policy              | multi-RPC cap            | single-RPC cap          |
 *   |---------------------|--------------------------|-------------------------|
 *   | pointRead           | RPC_READ_STALL (4s)      | uncapped (#894)         |
 *   | wideLogScan         | RPC_LOG_SCAN (30s)       | uncapped (#894)         |
 *   | durablePagedLogScan | uncapped                 | uncapped                |
 *   | watchdogPointRead   | RPC_READ_STALL (4s)      | RPC_READ_STALL (4s)    |
 *   | watchdogWideLogScan | RPC_LOG_SCAN (30s)       | RPC_LOG_SCAN (30s)     |
 *   | failOpenFundingRead | RPC_READ_STALL (4s)      | RPC_READ_STALL (4s)    |
 *   | securityGatePointRead | SECURITY_GATE (1s)     | uncapped                |
 *
 * `pointRead` / `wideLogScan` leave single-RPC uncapped (nothing to fail over
 * to; #894). The watchdog policies are for background reads that must clear
 * their scheduler gate even on one-RPC nodes, without imposing a poll-level
 * deadline over a multi-RPC failover sequence.
 */
export function resolveCapMs(policy: ReadPolicy, providerCount: number): number | undefined {
  if (policy === 'durablePagedLogScan') return undefined;
  if (policy === 'failOpenFundingRead' || policy === 'watchdogPointRead') {
    return RPC_READ_STALL_TIMEOUT_MS;
  }
  if (policy === 'watchdogWideLogScan') return RPC_LOG_SCAN_TIMEOUT_MS;
  if (providerCount <= 1) return undefined;
  if (policy === 'securityGatePointRead') return RPC_SECURITY_GATE_ATTEMPT_TIMEOUT_MS;
  return policy === 'wideLogScan' ? RPC_LOG_SCAN_TIMEOUT_MS : RPC_READ_STALL_TIMEOUT_MS;
}
