// SPDX-License-Identifier: Apache-2.0


import { type ReadPolicy } from './rpc-read-timeout-policy.js';

/**
 * The human-facing label and the low-cardinality telemetry owner for one RPC
 * read. Keeping them together prevents a read from accidentally changing its
 * diagnostic label while silently retaining (or losing) its usage bucket.
 * `consumer: null` is an explicit opt-out for reads that must remain
 * unattributed.
 */
export interface RpcReadDescriptor {
  readonly label: string;
  readonly consumer: string | null;
}

/** Construct an immutable, validated RPC read descriptor. */
export function createRpcReadDescriptor(
  label: string,
  consumer: string | null = label,
): RpcReadDescriptor {
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new TypeError('RPC read label must be a non-empty string');
  }
  if (consumer !== null && (typeof consumer !== 'string' || consumer.trim().length === 0)) {
    throw new TypeError('RPC read consumer must be a non-empty string or null');
  }
  return Object.freeze({ label, consumer });
}

/**
 * Bind an adapter read's human label and telemetry owner together.
 *
 * Kept as a module helper so it does not become part of the concrete adapter's
 * prototype API (the mock-adapter parity test intentionally enumerates that
 * surface).
 */
export function rpcReadDescriptor(label: string, opts?: ReadOpts): RpcReadDescriptor {
  const consumer = opts?.rpcUsageConsumer === undefined ? label : opts.rpcUsageConsumer;
  return createRpcReadDescriptor(label, consumer);
}

export type RpcReadDescriptorInput = string | RpcReadDescriptor;

/** Per-read options: timeout/failover behavior plus a compatibility escape
 *  hatch for callers that have not migrated to {@link RpcReadDescriptor} yet.
 *  New code should put the consumer owner beside the human label in a
 *  descriptor. `null` deliberately suppresses raw-read attribution. */
export interface ReadOpts {
  policy?: ReadPolicy;
  isRetryable?: (err: unknown) => boolean;
  /** @deprecated Use `RpcReadDescriptor.consumer`; retained for compatibility. */
  rpcUsageConsumer?: string | null;
  /**
   * Opt this read OUT of endpoint stickiness — it always uses the canonical
   * (configured) endpoint order AND never mutates the preferred pointer
   * (fully preference-transparent). Set on TIP-SENSITIVE reads (current head /
   * latest block) where a lagging preferred backend could return a stale/lower
   * head and make the tip non-monotonic across calls. A `skipPreferred` read on
   * a selectively-healthy primary must NOT clear the preference the heavy
   * read/write paths rely on — hence transparent, not merely canonical-ordered.
   */
  skipPreferred?: boolean;
  /**
   * Marks a read whose result may be a benign "not on this endpoint (yet)" EMPTY
   * value (e.g. `eth_getTransactionReceipt` / `getBlock` returning `null`) rather
   * than a definitive answer. When set, an empty result is NOT a transport
   * failure: the loop tries the next endpoint WITHOUT de-preferring it or emitting
   * failover/exhaustion telemetry, and if EVERY endpoint returns empty (and none
   * errored) the empty value itself is returned. A real transport error still
   * fails over / exhausts / propagates as usual. This keeps nullable reads
   * (receipt/tx/block lookups) failing over on a lagging endpoint without a thrown
   * sentinel polluting stickiness or telemetry.
   */
  isEmptyResult?: (value: unknown) => boolean;
  /** Retry a complete endpoint pass only when every failure was a throttle. */
  endpointSetRetry?: 'all-throttled';
  /** Cancels the active raw ethers FetchRequest for this read. */
  signal?: AbortSignal;
  /** Absolute operation deadline shared by every endpoint attempt. */
  deadlineMs?: number;
}
