/**
 * Tests for `shouldSuppressFatal` — the daemon's last-line-of-defense
 * classifier wired into `runDaemonInner`'s top-level
 * `uncaughtException` and `unhandledRejection` handlers.
 *
 * The classifier returns `{ suppress: boolean, category: string | null }`
 * for any thrown value. The handler logs a warning + keeps running when
 * `suppress=true`, otherwise it logs `[fatal]` and exits the process.
 * Anything we add to this allow-list pins one specific upstream bug —
 * we want the test surface to make that explicit so future widening
 * stays auditable.
 *
 * Pinned upstream bugs:
 *  - GossipSub stream-state races (long-standing libp2p-pubsub bug)
 *  - issue #286: `@libp2p/utils` job-queue `JobRecipient.onProgress`
 *    re-entrancy crashes the daemon during reconnect-on-gossip dials.
 */
import { describe, it, expect } from 'vitest';
import { shouldSuppressFatal } from '../src/daemon.js';

describe('shouldSuppressFatal — daemon top-level fatal-error classifier', () => {
  // -------------------------------------------------------------------
  // Existing GossipSub suppressions — must NOT regress.
  // -------------------------------------------------------------------
  it('suppresses "Cannot write to a stream that is..." (GossipSub)', () => {
    const err = new Error("Cannot write to a stream that is in 'closing' state");
    const v = shouldSuppressFatal(err);
    expect(v.suppress).toBe(true);
    expect(v.category).toMatch(/GossipSub/);
  });

  it('suppresses StreamStateError (GossipSub)', () => {
    const err = new Error('StreamStateError: stream already closed');
    expect(shouldSuppressFatal(err).suppress).toBe(true);
  });

  // -------------------------------------------------------------------
  // Issue #286 — libp2p JobRecipient.onProgress recursion.
  // The crash from the report is:
  //   RangeError: Maximum call stack size exceeded
  //     at JobRecipient.onProgress
  //         (file:///.../node_modules/@libp2p/utils/dist/src/queue/job.js:59:29)
  //     at file:///.../node_modules/@libp2p/utils/dist/src/queue/job.js:61:47
  //     at Array.forEach (<anonymous>)
  //     at JobRecipient.onProgress (...)
  //     ... (repeating)
  // -------------------------------------------------------------------
  it('suppresses libp2p JobRecipient.onProgress recursion (issue #286)', () => {
    const err = new RangeError('Maximum call stack size exceeded');
    err.stack = [
      'RangeError: Maximum call stack size exceeded',
      '    at JobRecipient.onProgress (file:///opt/homebrew/lib/node_modules/' +
        '@origintrail-official/dkg/node_modules/@libp2p/utils/dist/src/queue/' +
        'job.js:59:29)',
      '    at file:///opt/homebrew/lib/node_modules/@origintrail-official/dkg/' +
        'node_modules/@libp2p/utils/dist/src/queue/job.js:61:47',
      '    at Array.forEach (<anonymous>)',
      '    at JobRecipient.onProgress (...)',
    ].join('\n');

    const v = shouldSuppressFatal(err);
    expect(v.suppress).toBe(true);
    expect(v.category).toMatch(/libp2p|#286|onProgress/i);
  });

  // -------------------------------------------------------------------
  // Negative cases — anything we DON'T explicitly recognize must be
  // treated as fatal so real bugs aren't accidentally swallowed.
  // -------------------------------------------------------------------
  it('does NOT suppress unrelated RangeError without libp2p in the stack', () => {
    const err = new RangeError('Maximum call stack size exceeded');
    err.stack = [
      'RangeError: Maximum call stack size exceeded',
      '    at someAppCode (/Users/me/proj/src/foo.ts:42:7)',
      '    at otherFn (/Users/me/proj/src/bar.ts:10:1)',
    ].join('\n');

    expect(shouldSuppressFatal(err).suppress).toBe(false);
  });

  it('does NOT suppress arbitrary errors', () => {
    expect(shouldSuppressFatal(new Error('database connection lost')).suppress).toBe(false);
    expect(shouldSuppressFatal(new TypeError('foo is not a function')).suppress).toBe(false);
  });

  it('handles non-Error rejections defensively', () => {
    expect(shouldSuppressFatal('plain string').suppress).toBe(false);
    expect(shouldSuppressFatal(undefined).suppress).toBe(false);
    expect(shouldSuppressFatal(null).suppress).toBe(false);
    expect(shouldSuppressFatal(42).suppress).toBe(false);
  });

  it('does NOT suppress a RangeError with the right message but a non-libp2p stack', () => {
    // Stack-overflow in OUR code must still be a real fatal, otherwise
    // we'd hide infinite-recursion bugs we wrote ourselves.
    const err = new RangeError('Maximum call stack size exceeded');
    err.stack = [
      'RangeError: Maximum call stack size exceeded',
      '    at recursiveDoom (/Users/me/proj/src/our-bug.ts:1:1)',
      '    at recursiveDoom (/Users/me/proj/src/our-bug.ts:1:1)',
    ].join('\n');
    expect(shouldSuppressFatal(err).suppress).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — ways the suppression could over- or under-fire in the wild.
// Each entry pins the exact decision we want for that shape of input.
// ---------------------------------------------------------------------------
describe('shouldSuppressFatal — issue #286 edge cases', () => {
  /**
   * The match is `RangeError + msg + (path OR symbol)`. If only the
   * symbol `JobRecipient.onProgress` is present (e.g. a nested bundle
   * where the path is rewritten/source-mapped away), we still suppress.
   */
  it('matches on JobRecipient.onProgress symbol alone (path source-mapped away)', () => {
    const err = new RangeError('Maximum call stack size exceeded');
    err.stack = [
      'RangeError: Maximum call stack size exceeded',
      '    at JobRecipient.onProgress (some-bundled-path.js:1:1)',
      '    at Array.forEach (<anonymous>)',
      '    at JobRecipient.onProgress (some-bundled-path.js:2:1)',
    ].join('\n');
    expect(shouldSuppressFatal(err).suppress).toBe(true);
  });

  /**
   * Mirror of the above: only the path is present (e.g. a future libp2p
   * version that renames `JobRecipient` to something else). Path alone
   * is enough — the @libp2p/utils package boundary is the load-bearing
   * signal.
   */
  it('matches on @libp2p/utils path alone (class renamed upstream)', () => {
    const err = new RangeError('Maximum call stack size exceeded');
    err.stack = [
      'RangeError: Maximum call stack size exceeded',
      '    at NewName.dispatch (file:///x/node_modules/@libp2p/utils/dist/' +
        'src/queue/job.js:99:1)',
    ].join('\n');
    expect(shouldSuppressFatal(err).suppress).toBe(true);
  });

  /**
   * A `RangeError` with no `.stack` at all (some sandboxes / minified
   * runtimes drop it). We CANNOT confirm it's the libp2p bug, so we
   * must NOT suppress. Erring on the side of "let it crash and get
   * reported" is the correct call.
   */
  it('does NOT suppress a RangeError with no stack at all', () => {
    const err = new RangeError('Maximum call stack size exceeded');
    err.stack = undefined as unknown as string;
    expect(shouldSuppressFatal(err).suppress).toBe(false);
  });

  /**
   * Error with the magic message AND libp2p-stack BUT it's not a
   * RangeError instance — e.g. someone re-threw `new Error(orig.message)`
   * losing the type. Strict `instanceof RangeError` is intentional:
   * we want a tight match against the V8-thrown shape, not a fuzzy one.
   */
  it('does NOT suppress a non-RangeError pretending to be the libp2p bug', () => {
    const err = new Error('Maximum call stack size exceeded');
    err.stack = [
      'Error: Maximum call stack size exceeded',
      '    at JobRecipient.onProgress (file:///x/node_modules/@libp2p/utils/' +
        'dist/src/queue/job.js:59:29)',
    ].join('\n');
    expect(shouldSuppressFatal(err).suppress).toBe(false);
  });

  /**
   * Unrelated RangeError originating in libp2p (e.g. an array length
   * out of range somewhere in @libp2p/utils). The msg substring guard
   * prevents over-suppression of arbitrary libp2p RangeErrors.
   */
  it('does NOT suppress an unrelated RangeError from libp2p (different message)', () => {
    const err = new RangeError('Invalid array length');
    err.stack = [
      'RangeError: Invalid array length',
      '    at file:///x/node_modules/@libp2p/utils/dist/src/buffer.js:10:5',
    ].join('\n');
    expect(shouldSuppressFatal(err).suppress).toBe(false);
  });

  /**
   * Some other libp2p subpackage (`@libp2p/pubsub`, `@libp2p/peer-id`,
   * etc.) — only `@libp2p/utils` is the known-bad recursion site, so
   * matching a different package path must NOT suppress.
   */
  it('does NOT suppress a RangeError whose stack only mentions a different libp2p subpackage', () => {
    const err = new RangeError('Maximum call stack size exceeded');
    err.stack = [
      'RangeError: Maximum call stack size exceeded',
      '    at file:///x/node_modules/@libp2p/pubsub/dist/index.js:1:1',
      '    at file:///x/node_modules/@libp2p/pubsub/dist/index.js:2:1',
    ].join('\n');
    expect(shouldSuppressFatal(err).suppress).toBe(false);
  });

  /**
   * Transitive bundling: some upstream package vendors libp2p inside
   * its own node_modules tree. The substring is package-name-based so
   * it still fires.
   */
  it('matches when @libp2p/utils is nested under another package', () => {
    const err = new RangeError('Maximum call stack size exceeded');
    err.stack = [
      'RangeError: Maximum call stack size exceeded',
      '    at JobRecipient.onProgress (file:///x/node_modules/some-vendor/' +
        'node_modules/@libp2p/utils/dist/src/queue/job.js:59:29)',
    ].join('\n');
    expect(shouldSuppressFatal(err).suppress).toBe(true);
  });

  /**
   * Error tracebacks coming via `unhandledRejection` are sometimes
   * raw values, not Error instances (a microtask rejecting a promise
   * with a plain string). Already covered above for the negative case;
   * this re-pins the contract that `category` is `null` on no match.
   */
  it('returns category=null when no rule matches', () => {
    const v = shouldSuppressFatal(new Error('totally unrelated'));
    expect(v.suppress).toBe(false);
    expect(v.category).toBeNull();
  });

  /**
   * End-to-end shape verification: trigger an ACTUAL stack overflow in
   * Node (no hand-crafted strings), assemble a stack that looks like
   * the libp2p case by reusing the real frames, and confirm we'd
   * suppress it. This guards against a future Node upgrade that
   * changes the `.stack` format in a way our substring no longer
   * matches.
   */
  it('matches a real-Node-produced RangeError when frames mention @libp2p/utils', () => {
    function realRecursion(): never {
      // Trigger a real V8 RangeError to capture an authentic stack.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _x = realRecursion();
      throw new Error('unreachable');
    }

    let real: RangeError | null = null;
    try {
      realRecursion();
    } catch (e) {
      real = e as RangeError;
    }

    expect(real).toBeInstanceOf(RangeError);
    expect(real!.message).toBe('Maximum call stack size exceeded');
    // Our app-stack should NOT trigger suppression on its own.
    expect(shouldSuppressFatal(real!).suppress).toBe(false);

    // Now graft a libp2p-style frame into the same real error, the
    // way it actually happens in production (the deepest frames are
    // the recursive ones). The helper should now suppress.
    real!.stack = [
      'RangeError: Maximum call stack size exceeded',
      '    at JobRecipient.onProgress (file:///opt/homebrew/lib/node_modules/' +
        '@origintrail-official/dkg/node_modules/@libp2p/utils/dist/src/queue/' +
        'job.js:59:29)',
      '    at Array.forEach (<anonymous>)',
      ...(real!.stack || '').split('\n').slice(1, 5),
    ].join('\n');

    const v = shouldSuppressFatal(real!);
    expect(v.suppress).toBe(true);
    expect(v.category).toMatch(/#286/);
  });

  /**
   * `Error.cause` chain: if a wrapping layer attaches a fresh Error
   * whose `.cause` is the real RangeError, the OUTER value reaches
   * the handler — we should NOT suppress that, because the cause is
   * a separate property we don't inspect. This test pins that decision
   * explicitly so a future maintainer who decides to walk `.cause`
   * has to update the test alongside the code.
   */
  it('does NOT recursively unwrap Error.cause chains', () => {
    const inner = new RangeError('Maximum call stack size exceeded');
    inner.stack = [
      'RangeError: Maximum call stack size exceeded',
      '    at JobRecipient.onProgress (file:///x/node_modules/@libp2p/utils/' +
        'dist/src/queue/job.js:59:29)',
    ].join('\n');
    const outer = new Error('wrapped: dial failed', { cause: inner });
    expect(shouldSuppressFatal(outer).suppress).toBe(false);
  });

  /**
   * Whitespace / casing in the error message: V8 produces this exact
   * string. We do `.includes()` so leading/trailing wrappers in the
   * message are fine. Lock that contract.
   */
  it('matches even when the message has leading prefix wrapping', () => {
    const err = new RangeError(
      'agent dial failed: Maximum call stack size exceeded — see traces',
    );
    err.stack = [
      'RangeError: ...',
      '    at file:///x/node_modules/@libp2p/utils/dist/src/queue/job.js:1:1',
    ].join('\n');
    expect(shouldSuppressFatal(err).suppress).toBe(true);
  });

  /**
   * Sanity: the helper is pure and side-effect-free. Calling it twice
   * with the same input must yield the same verdict. Locks the contract
   * for any future caller that memoizes.
   */
  it('is referentially transparent (pure)', () => {
    const err = new RangeError('Maximum call stack size exceeded');
    err.stack = [
      'RangeError: Maximum call stack size exceeded',
      '    at JobRecipient.onProgress (file:///x/node_modules/@libp2p/utils/' +
        'dist/src/queue/job.js:59:29)',
    ].join('\n');
    const a = shouldSuppressFatal(err);
    const b = shouldSuppressFatal(err);
    expect(a).toEqual(b);
    expect(b.suppress).toBe(true);
  });
});
