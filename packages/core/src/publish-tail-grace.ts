/**
 * Bounded grace for post-confirm publish "tails" (GH #1572).
 *
 * After a V10 publish confirms on-chain, the caller-facing result
 * (ual / kaId / txHash / status) is complete — but the code still runs a
 * serial tail of store mutations (SWM cleanup sweeps, `_meta` lifecycle
 * stamps). Every one of those mutations is submitted to the store queue
 * with no deadline, so on a node whose store queue is congested (large
 * accumulated graphs + sustained inbound ACK/SWM traffic) the tail — and
 * therefore the HTTP response that awaits it — can take many minutes.
 * Measured on mainnet cores: confirm at +4s, response at +9..18 min and
 * growing, with the TCP connection dying at ~12 min. The same publish on
 * an idle node completes the tail in well under a second.
 *
 * `awaitTailWithGrace` keeps the tail's semantics intact while unhooking
 * it from the response path:
 *  - the tail always runs to completion, in order, exactly once;
 *  - if it settles within `graceMs`, behavior is byte-identical to a plain
 *    `await` (including error propagation to the caller);
 *  - if it is still running after `graceMs`, the caller proceeds (the
 *    response goes out) and the tail continues detached; its eventual
 *    settlement is reported through `onDetachedSettled` so a failure is
 *    logged rather than becoming an unhandled rejection.
 *
 * On a healthy node the grace never elapses, so this changes nothing.
 */

export const DEFAULT_PUBLISH_TAIL_GRACE_MS = 5_000;

/**
 * Resolve the grace budget from `DKG_PUBLISH_TAIL_GRACE_MS`. Invalid or
 * missing values fall back to {@link DEFAULT_PUBLISH_TAIL_GRACE_MS}; `0`
 * is honored (respond immediately, tail fully detached).
 */
export function resolvePublishTailGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DKG_PUBLISH_TAIL_GRACE_MS;
  if (raw === undefined || raw === '') return DEFAULT_PUBLISH_TAIL_GRACE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PUBLISH_TAIL_GRACE_MS;
  return Math.floor(n);
}

const TAIL_GRACE_TIMEOUT: unique symbol = Symbol('publish-tail-grace-timeout');

/**
 * Await `tail` for up to `graceMs`.
 *
 * Returns `'completed'` when the tail settled in time — a rejection inside
 * the grace window is rethrown to the caller, exactly like a plain `await`.
 * Returns `'detached'` when the grace elapsed first; the still-running tail
 * keeps executing and `onDetachedSettled` fires exactly once when it
 * eventually settles (with the error when it failed, `undefined` on
 * success), guaranteeing the rejection is consumed.
 */
export async function awaitTailWithGrace(
  graceMs: number,
  tail: Promise<void>,
  onDetachedSettled: (error?: unknown) => void,
): Promise<'completed' | 'detached'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const winner = await Promise.race([
      tail,
      new Promise<typeof TAIL_GRACE_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TAIL_GRACE_TIMEOUT), Math.max(0, graceMs));
        // Never keep the process alive just to time out a grace window.
        timer.unref?.();
      }),
    ]);
    if (winner === TAIL_GRACE_TIMEOUT) {
      tail.then(
        () => onDetachedSettled(),
        (err) => onDetachedSettled(err),
      );
      return 'detached';
    }
    return 'completed';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
