// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a connection can carry direct share delivery.
 *
 * A connection through a relay has an allowance: the bytes it may still carry
 * and the seconds it stays open, as granted by the relay. A share went only
 * to peers with a connection that has no allowance at all, that is, a direct
 * one. That rule dates from relays that granted about 128 KiB and two minutes
 * for a circuit: delivery used the allowance up at once, every later send
 * failed and was queued again, and each retry consumed the next circuit.
 *
 * Core nodes grant far more for a circuit now (256 MiB and 30 minutes), which
 * is thousands of shares. Two edge nodes that reach each other only through
 * such a relay had no way to deliver a share to each other. A relayed
 * connection therefore counts when enough of its allowance is left; one with
 * a small allowance stays excluded for the reason above.
 */

/** Bytes that must be left on a relayed connection for share delivery to use it. */
export const SHARE_DELIVERY_MIN_RELAYED_BYTES = 16n * 1024n * 1024n;
/**
 * Seconds that must be left on a relayed connection for share delivery to use it.
 *
 * The bytes are what tells a small allowance from a large one. The relay
 * server of @libp2p/circuit-relay-v2 puts its duration on the wire in
 * milliseconds and the client reads the field as seconds, so through such a
 * relay the seconds read 1,000 times too large (1,800,000 for 30 minutes,
 * 120,000 for the default 2 minutes) and never fail this check. It still
 * catches a relay that reports real seconds.
 */
export const SHARE_DELIVERY_MIN_RELAYED_SECONDS = 5 * 60;

/**
 * `limits` is a connection's `limits` as libp2p reports it: absent on a
 * direct connection, otherwise the bytes and seconds that remain. A limit the
 * relay did not set is absent and does not restrict.
 */
export function connectionCarriesShareDelivery(limits: unknown): boolean {
  if (limits === undefined || limits === null) return true;
  if (typeof limits !== 'object') return false;
  const { bytes, seconds } = limits as { bytes?: unknown; seconds?: unknown };
  // A value of another type, or NaN, fails its comparison: an allowance this node cannot read is not relied on.
  const enoughBytes = bytes === undefined || bytes === null
    || (typeof bytes === 'bigint'
      ? bytes >= SHARE_DELIVERY_MIN_RELAYED_BYTES
      : typeof bytes === 'number' && bytes >= Number(SHARE_DELIVERY_MIN_RELAYED_BYTES));
  const enoughSeconds = seconds === undefined || seconds === null
    || (typeof seconds === 'number' && seconds >= SHARE_DELIVERY_MIN_RELAYED_SECONDS);
  return enoughBytes && enoughSeconds;
}
