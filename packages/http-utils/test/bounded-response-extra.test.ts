import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { BoundedResponseBodyLimitError, readResponseBodyBytesBounded } from '../src/index.js';

describe('bounded response failure and resource contracts', () => {
  it.each([NaN, Infinity, -Infinity, 0.5, -1, Number.MAX_SAFE_INTEGER + 1])
    ('rejects invalid byte ceiling %s before locking or cancelling the body', async maxBytes => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      await expect(readResponseBodyBytesBounded(new Response(body), maxBytes))
        .rejects.toThrow(RangeError);
      expect(body.locked).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
      await body.cancel();
    });

  it.each(['header', 'stream'] as const)('preserves the size error if %s cancellation rejects', async source => {
    const cancel = vi.fn().mockRejectedValue(new Error('cancellation failed'));
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); }, cancel,
    });
    const response = new Response(body, source === 'header' ? { headers: { 'content-length': '2' } } : {});
    await expect(readResponseBodyBytesBounded(response, 1)).rejects.toMatchObject({
      name: 'BoundedResponseBodyLimitError', maxBytes: 1,
      actualBytes: source === 'header' ? 2n : 2,
      source: source === 'header' ? 'content-length' : 'stream',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('releases the reader and preserves a midstream read error', async () => {
    const failure = new Error('connection reset');
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new Uint8Array([1]));
        else controller.error(failure);
      },
    });
    await expect(readResponseBodyBytesBounded(new Response(body), 8)).rejects.toBe(failure);
    expect(reads).toBe(2);
    expect(body.locked).toBe(false);
  });

  it('compares huge declared lengths as bigint even without a body', async () => {
    await expect(readResponseBodyBytesBounded(new Response(null, {
      headers: { 'content-length': '9007199254740993' },
    }), Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({
      maxBytes: Number.MAX_SAFE_INTEGER, actualBytes: 9007199254740993n, source: 'content-length',
    });
  });

  it.each(['-1', '1.5', 'NaN', 'not-a-length', '0', '1'])
    ('still enforces the streamed bytes when the declared length is %s', async length => {
      await expect(readResponseBodyBytesBounded(new Response(new Uint8Array([1, 2]), {
        headers: { 'content-length': length },
      }), 1)).rejects.toMatchObject({ source: 'stream', actualBytes: 2 });
    });

  it('measures UTF-8 bytes, including a multi-byte character at the limit', async () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]);
    await expect(readResponseBodyBytesBounded(new Response('café'), 5)).resolves.toEqual(bytes);
    await expect(readResponseBodyBytesBounded(new Response('café'), 4))
      .rejects.toBeInstanceOf(BoundedResponseBodyLimitError);
  });

  it('returns an empty body at a zero-byte limit and releases the reader', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array()); controller.close(); },
    });
    await expect(readResponseBodyBytesBounded(new Response(body, {
      headers: { 'content-length': '0' },
    }), 0)).resolves.toEqual(new Uint8Array());
    expect(body.locked).toBe(false);
  });

  it('preserves arbitrary bytes across chunk partitions and enforces the exact boundary', async () => {
    // Deterministic, shrinkable cases cover empty chunks, binary data, and
    // overflow in different chunk positions without relying on timing.
    await fc.assert(fc.asyncProperty(
      fc.array(fc.uint8Array({ maxLength: 24 }), { maxLength: 12 }),
      async chunks => {
        const expected = Uint8Array.from(chunks.flatMap(chunk => Array.from(chunk)));
        const stream = () => new ReadableStream<Uint8Array>({
          start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
        });
        const body = stream();
        await expect(readResponseBodyBytesBounded(new Response(body), expected.length)).resolves.toEqual(expected);
        expect(body.locked).toBe(false);
        if (expected.length > 0) {
          const overflow = stream();
          await expect(readResponseBodyBytesBounded(new Response(overflow), expected.length - 1))
            .rejects.toMatchObject({ source: 'stream', actualBytes: expected.length });
          expect(overflow.locked).toBe(false);
        }
      },
    ), { seed: 241026, numRuns: 100 });
  });
});
