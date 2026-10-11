import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { relayAnswer } from '../src/adapters/sparql-answer-relay.js';

/**
 * The relay between a managed read's transport body and its consumer. While the
 * caller stays it only forwards; when the caller leaves it fails the consumer at
 * once and discards what remains of the body, for at most a byte budget.
 */

const BUDGET = 64;
const CHUNK = 16;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

/**
 * A FINITE transport body produced only as fast as it is read (`highWaterMark:
 * 0`: every `pull` is a real read), so `pulled()` is what the client has read.
 * `stallAfterBytes` makes the server stall between writes until `resume()`.
 */
function transport(options: {
  readonly totalBytes: number;
  readonly stallAfterBytes?: number;
  readonly status?: number;
}) {
  const { totalBytes, stallAfterBytes = Number.POSITIVE_INFINITY, status = 200 } = options;
  let pulled = 0;
  let cancelled = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    async pull(c) {
      if (pulled >= stallAfterBytes) await gate;
      if (cancelled) return;
      if (pulled >= totalBytes) {
        c.close();
        return;
      }
      const size = Math.min(CHUNK, totalBytes - pulled);
      pulled += size;
      c.enqueue(new Uint8Array(size).fill(0x41));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return {
    response: new Response(stream, { status, statusText: 'Teapot', headers: { 'x-answer': 'yes' } }),
    pulled: () => pulled,
    cancelled: () => cancelled,
    resume,
    fail: (error: unknown) => controller.error(error),
  };
}

const outcome = <T>(promise: Promise<T>) => promise.then(
  (value) => ({ value }),
  (error: unknown) => ({ error }),
);

describe('relayAnswer while the caller stays', () => {
  it('forwards the body untouched, keeps status and headers, and reports the server finished', async () => {
    const left = new AbortController();
    const source = transport({ totalBytes: 50 });
    const relay = relayAnswer(source.response, left.signal, BUDGET);

    expect(relay.response).not.toBe(source.response);
    expect(relay.response.status).toBe(200);
    expect(relay.response.statusText).toBe('Teapot');
    expect(relay.response.headers.get('x-answer')).toBe('yes');
    expect(await relay.response.text()).toBe('A'.repeat(50));
    expect(await relay.finish()).toBe(true);
    // Nothing is left listening on the caller's (long-lived) signal.
    expect(getEventListeners(left.signal, 'abort')).toHaveLength(0);
  });

  it('reads no further than the consumer asks for', async () => {
    const source = transport({ totalBytes: 10 * CHUNK });
    const relay = relayAnswer(source.response, new AbortController().signal, BUDGET);
    const reader = relay.response.body!.getReader();
    await reader.read();
    await reader.read();
    await settle();
    expect(source.pulled()).toBe(2 * CHUNK);
    await reader.cancel();
  });

  it('passes an answer without a body through as it is, and counts it as finished', async () => {
    const answer = new Response(null, { status: 204 });
    const relay = relayAnswer(answer, new AbortController().signal, BUDGET);
    expect(relay.response).toBe(answer);
    expect(await relay.finish()).toBe(true);
  });

  it('passes a response that has no body property through as it is', async () => {
    const answer = { ok: true, status: 200, text: async () => 'x' } as unknown as Response;
    const relay = relayAnswer(answer, new AbortController().signal, BUDGET);
    expect(relay.response).toBe(answer);
    expect(await relay.finish()).toBe(true);
  });

  it('shows nothing about the server when the transport body fails, and passes the failure on', async () => {
    const left = new AbortController();
    const source = transport({ totalBytes: 10 * CHUNK, stallAfterBytes: CHUNK });
    const relay = relayAnswer(source.response, left.signal, BUDGET);
    const text = outcome(relay.response.text());
    await settle();
    const failure = new TypeError('terminated');
    source.fail(failure);
    source.resume();
    expect(await text).toEqual({ error: failure });
    expect(await relay.finish()).toBe(false);
    expect(getEventListeners(left.signal, 'abort')).toHaveLength(0);
  });

  it('lets go of the transport when the consumer cancels, and reports nothing finished', async () => {
    const source = transport({ totalBytes: 10 * CHUNK });
    const relay = relayAnswer(source.response, new AbortController().signal, BUDGET);
    const reader = relay.response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(source.cancelled()).toBe(true);
    expect(await relay.finish()).toBe(false);
  });

  it('lets go of the transport when the consumer stops short with its caller still there', async () => {
    const source = transport({ totalBytes: 10 * CHUNK });
    const relay = relayAnswer(source.response, new AbortController().signal, BUDGET);
    const reader = relay.response.body!.getReader();
    await reader.read();
    // The consumer failed for its own reasons and read no more.
    expect(await relay.finish()).toBe(false);
    expect(source.cancelled()).toBe(true);
    await settle();
    expect(source.pulled()).toBe(CHUNK);
  });

  it('ignores a chunk that arrives after the consumer let go', async () => {
    const source = transport({ totalBytes: 10 * CHUNK, stallAfterBytes: CHUNK });
    const relay = relayAnswer(source.response, new AbortController().signal, BUDGET);
    const reader = relay.response.body!.getReader();
    await reader.read();
    void reader.read().catch(() => undefined); // pending: the server stalls
    await settle();
    expect(await relay.finish()).toBe(false);
    source.resume();
    await settle();
    // Nothing more was read for anybody.
    expect(source.pulled()).toBe(CHUNK);
  });
});

describe('relayAnswer once the caller has left', () => {
  it('fails a pending read at once with the caller\'s reason, then reads the short rest out', async () => {
    const left = new AbortController();
    const source = transport({ totalBytes: 3 * CHUNK, stallAfterBytes: CHUNK });
    const relay = relayAnswer(source.response, left.signal, BUDGET);
    const text = outcome(relay.response.text());
    await settle();
    expect(source.pulled()).toBe(CHUNK);

    const reason = new Error('caller budget exhausted');
    left.abort(reason);
    // The consumer is failed at once, while the server is still stalled.
    expect(await text).toEqual({ error: reason });

    source.resume();
    // The rest is read out (and thrown away): the server was seen to finish.
    expect(await relay.finish()).toBe(true);
    expect(source.pulled()).toBe(3 * CHUNK);
    expect(source.cancelled()).toBe(false);
    expect(getEventListeners(left.signal, 'abort')).toHaveLength(0);
  });

  it('reads at most the budget plus one chunk of a long rest, then cancels it', async () => {
    const left = new AbortController();
    const source = transport({ totalBytes: 1000 * CHUNK, stallAfterBytes: CHUNK });
    const relay = relayAnswer(source.response, left.signal, BUDGET);
    void relay.response.text().catch(() => undefined);
    await settle();

    left.abort(new Error('gone'));
    source.resume();
    expect(await relay.finish()).toBe(false);
    expect(source.cancelled()).toBe(true);
    // One chunk was read for the consumer; then the budget (exceeded by the last chunk).
    const readAfterLeaving = source.pulled() - CHUNK;
    expect(readAfterLeaving).toBeGreaterThan(BUDGET);
    expect(readAfterLeaving).toBeLessThanOrEqual(BUDGET + CHUNK);
  });

  it('counts a rest that ends exactly at the budget as finished, and one a byte over as not', async () => {
    for (const [extra, finished] of [[0, true], [1, false]] as const) {
      const left = new AbortController();
      // 1 chunk for the consumer, then BUDGET (+ extra) bytes to discard.
      const source = transport({ totalBytes: CHUNK + BUDGET + extra, stallAfterBytes: CHUNK });
      const relay = relayAnswer(source.response, left.signal, BUDGET);
      void relay.response.text().catch(() => undefined);
      await settle();
      left.abort(new Error('gone'));
      source.resume();
      expect(await relay.finish()).toBe(finished);
      expect(source.cancelled()).toBe(!finished);
    }
  });

  it('starts discarding by itself when the caller leaves between the consumer\'s reads', async () => {
    const left = new AbortController();
    const source = transport({ totalBytes: 4 * CHUNK });
    const relay = relayAnswer(source.response, left.signal, BUDGET);
    const reader = relay.response.body!.getReader();
    await reader.read();
    await settle();
    // No read is pending now.
    const reason = new Error('caller left');
    left.abort(reason);
    expect(await outcome(reader.read())).toEqual({ error: reason });
    expect(await relay.finish()).toBe(true);
    expect(source.pulled()).toBe(4 * CHUNK);
  });

  it('discards straight away for a caller that had already left', async () => {
    const left = new AbortController();
    left.abort(new Error('already gone'));
    const short = transport({ totalBytes: 2 * CHUNK });
    expect(await relayAnswer(short.response, left.signal, BUDGET).finish()).toBe(true);
    expect(short.pulled()).toBe(2 * CHUNK);

    const long = transport({ totalBytes: 1000 * CHUNK });
    expect(await relayAnswer(long.response, left.signal, BUDGET).finish()).toBe(false);
    expect(long.cancelled()).toBe(true);
    expect(long.pulled()).toBeLessThanOrEqual(BUDGET + CHUNK);
  });

  it('shows nothing about the server when the body then fails', async () => {
    const left = new AbortController();
    const source = transport({ totalBytes: 10 * CHUNK, stallAfterBytes: CHUNK });
    const relay = relayAnswer(source.response, left.signal, BUDGET);
    void relay.response.text().catch(() => undefined);
    await settle();
    left.abort(new Error('gone'));
    source.fail(new TypeError('terminated'));
    source.resume();
    expect(await relay.finish()).toBe(false);
  });

  it('shows nothing about the server when the body fails while the discard is reading', async () => {
    const left = new AbortController();
    left.abort(new Error('already gone'));
    const source = transport({ totalBytes: 10 * CHUNK, stallAfterBytes: CHUNK });
    const relay = relayAnswer(source.response, left.signal, BUDGET);
    await settle();
    source.fail(new TypeError('terminated'));
    source.resume();
    expect(await relay.finish()).toBe(false);
  });
});
