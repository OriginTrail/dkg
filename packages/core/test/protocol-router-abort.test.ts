/**
 * Unit tests for PR-6: AbortSignal plumbing through DKGNode.stop().
 *
 * Two surfaces:
 *   - `readAllWithSignal`: race-the-read-against-signal logic. Covers
 *     pre-aborted, aborts-during-read, aborts-after-read-completes,
 *     no-signal passthrough, stream.abort() called on the underlying
 *     stream when signal fires.
 *   - `composeAbortSignals`: signal-composition helper. Covers
 *     primary-only, secondary-only, neither (returns undefined),
 *     either fires → composed fires, pre-aborted inputs.
 *
 * Both helpers are exported expressly for testability — the real
 * integration with DKGNode.stop() → libp2p.stop() is not unit-testable
 * without spinning a libp2p instance, so we trust the per-helper unit
 * coverage + the production wire-up review.
 */

import { describe, it, expect } from 'vitest';
import { readAllWithSignal, composeAbortSignals } from '../src/protocol-router.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

function streamFromChunks(chunks: Uint8Array[]): AsyncIterable<Uint8Array> & { abort: (err: Error) => void; aborted: { err: Error } | null } {
  const state = { aborted: null as { err: Error } | null };
  return {
    aborted: state.aborted,
    abort(err: Error) {
      state.aborted = { err };
      (this as { aborted: { err: Error } | null }).aborted = { err };
    },
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (state.aborted) throw state.aborted.err;
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[i++] };
        },
      };
    },
  };
}

/**
 * Stream that hangs indefinitely on the iterator's `.next()` call,
 * resolving only when `release()` is invoked OR `abort()` is called
 * on the stream. Mirrors the real-world deadlock: peer sent zero
 * bytes and never closes the stream.
 */
function hangingStream(): {
  stream: AsyncIterable<Uint8Array> & { abort: (err: Error) => void };
  releaseChunk(chunk: Uint8Array): void;
  releaseDone(): void;
} {
  let waiting: { resolve: (v: IteratorResult<Uint8Array>) => void; reject: (e: Error) => void } | null = null;
  let aborted = false;
  let abortErr: Error | null = null;
  const stream = {
    abort(err: Error) {
      aborted = true;
      abortErr = err;
      if (waiting) {
        waiting.reject(err);
        waiting = null;
      }
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (aborted) throw abortErr ?? new Error('aborted');
          return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
            waiting = { resolve, reject };
          });
        },
      };
    },
  };
  return {
    stream,
    releaseChunk(chunk: Uint8Array) {
      const w = waiting;
      waiting = null;
      w?.resolve({ done: false, value: chunk });
    },
    releaseDone() {
      const w = waiting;
      waiting = null;
      w?.resolve({ done: true, value: undefined });
    },
  };
}

describe('readAllWithSignal', () => {
  it('passes through to plain readAll when no signal provided', async () => {
    const chunks = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)];
    const result = await readAllWithSignal(streamFromChunks(chunks), 1024, undefined);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it('throws immediately when the signal is already aborted at entry', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('pre-aborted'));
    const stream = streamFromChunks([Uint8Array.of(1)]);
    await expect(readAllWithSignal(stream, 1024, ctrl.signal)).rejects.toThrow(/pre-aborted/);
  });

  it('aborts the underlying stream when signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('pre-aborted'));
    const stream = streamFromChunks([Uint8Array.of(1)]);
    const origAbort = stream.abort.bind(stream);
    const abortSpy = recorder((...a: [Error]) => origAbort(...a));
    stream.abort = abortSpy;
    await expect(readAllWithSignal(stream, 1024, ctrl.signal)).rejects.toThrow();
    expect(abortSpy.calls.length).toBeGreaterThan(0);
  });

  it('aborts a hanging read when the signal fires mid-flight (the beacon-01 repro)', async () => {
    const { stream } = hangingStream();
    const ctrl = new AbortController();
    const readPromise = readAllWithSignal(stream, 1024, ctrl.signal);
    // Read is parked on the iterator's .next() — abort should unwedge it.
    setTimeout(() => ctrl.abort(new Error('shutdown')), 10);
    await expect(readPromise).rejects.toThrow(/shutdown/);
  });

  it('returns successfully when the read completes before any abort', async () => {
    const ctrl = new AbortController();
    const result = await readAllWithSignal(
      streamFromChunks([Uint8Array.of(1, 2, 3)]),
      1024,
      ctrl.signal,
    );
    expect(Array.from(result)).toEqual([1, 2, 3]);
    // Aborting AFTER the read completes is a no-op (Promise.race already
    // resolved to the read).
    ctrl.abort(new Error('too late'));
  });

  it('does not leak the abort listener after a successful read', async () => {
    const ctrl = new AbortController();
    const origRemove = ctrl.signal.removeEventListener.bind(ctrl.signal);
    const removeSpy = recorder((...a: Parameters<AbortSignal['removeEventListener']>) =>
      origRemove(...a),
    );
    ctrl.signal.removeEventListener = removeSpy as AbortSignal['removeEventListener'];
    await readAllWithSignal(streamFromChunks([Uint8Array.of(1)]), 1024, ctrl.signal);
    expect(removeSpy.calls).toContainEqual(['abort', expect.any(Function)]);
  });

  it('does not leak the abort listener after an aborted read', async () => {
    const { stream } = hangingStream();
    const ctrl = new AbortController();
    const origRemove = ctrl.signal.removeEventListener.bind(ctrl.signal);
    const removeSpy = recorder((...a: Parameters<AbortSignal['removeEventListener']>) =>
      origRemove(...a),
    );
    ctrl.signal.removeEventListener = removeSpy as AbortSignal['removeEventListener'];
    const p = readAllWithSignal(stream, 1024, ctrl.signal);
    ctrl.abort(new Error('cancel'));
    await p.catch(() => {});
    expect(removeSpy.calls).toContainEqual(['abort', expect.any(Function)]);
  });
});

describe('composeAbortSignals', () => {
  it('returns undefined when both inputs are undefined', () => {
    expect(composeAbortSignals(undefined, undefined)).toBeUndefined();
  });

  it('returns the lone signal when only one input is provided (primary)', () => {
    const c = new AbortController();
    expect(composeAbortSignals(c.signal, undefined)).toBe(c.signal);
  });

  it('returns the lone signal when only one input is provided (secondary)', () => {
    const c = new AbortController();
    expect(composeAbortSignals(undefined, c.signal)).toBe(c.signal);
  });

  it('composed signal aborts when the primary aborts', async () => {
    const a = new AbortController();
    const b = new AbortController();
    const composed = composeAbortSignals(a.signal, b.signal)!;
    expect(composed.aborted).toBe(false);
    a.abort(new Error('A fired'));
    expect(composed.aborted).toBe(true);
  });

  it('composed signal aborts when the secondary aborts', async () => {
    const a = new AbortController();
    const b = new AbortController();
    const composed = composeAbortSignals(a.signal, b.signal)!;
    b.abort(new Error('B fired'));
    expect(composed.aborted).toBe(true);
  });

  it('composed signal is already-aborted when EITHER input is pre-aborted', () => {
    const a = new AbortController();
    a.abort(new Error('pre-A'));
    const b = new AbortController();
    const composed = composeAbortSignals(a.signal, b.signal)!;
    expect(composed.aborted).toBe(true);
  });
});
