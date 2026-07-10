/**
 * Append every element of `source` onto `target`, in place, without the
 * argument-spread form (`target.push(...source)`).
 *
 * `Array.prototype.push(...source)` passes each element of `source` as a
 * separate function argument. V8 bounds the number of arguments a single call
 * may spread onto the stack (empirically ~1.25e5 elements on Node 22) and
 * throws `RangeError: Maximum call stack size exceeded` past that bound. The
 * sync responder and requester assemble store- and network-sized row/quad
 * arrays — a single shared-memory data graph routinely holds far more than that
 * limit — so the spread form crashes the `/dkg/x/sync` handler mid-serve on a
 * large context graph. The failure surfaces as
 * `[ProtocolRouter] handler error on /dkg/x/sync from <peer>: Maximum call
 * stack size exceeded`, the stream is aborted, and the requesting member never
 * receives the data (it retries and backs off forever).
 *
 * A plain index loop appends one element per iteration, is O(n) like the
 * spread, preserves order, and has no argument-count bound.
 */
export function appendInPlace<T>(target: T[], source: readonly T[]): void {
  for (let i = 0; i < source.length; i += 1) {
    target.push(source[i]);
  }
}
