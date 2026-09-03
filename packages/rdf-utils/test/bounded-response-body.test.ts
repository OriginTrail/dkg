import { describe, expect, it } from 'vitest';
import {
  BoundedResponseBodyLimitError,
  readResponseBodyBytesBounded,
} from '../src/bounded-response-body.js';

describe('bounded response body collection', () => {
  it('cancels immediately when Content-Length exceeds the ceiling', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    await expect(readResponseBodyBytesBounded(new Response(body, {
      headers: { 'Content-Length': '129' },
    }), 128)).rejects.toMatchObject({
      maxBytes: 128,
      actualBytes: 129n,
      source: 'content-length',
    });
    expect(cancelled).toBe(true);
  });

  it('cancels a stream on overflow and reports received bytes', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readResponseBodyBytesBounded(new Response(body), 3)).rejects.toMatchObject({
      maxBytes: 3,
      actualBytes: 4,
      source: 'stream',
    });
    expect(cancelled).toBe(true);
  });

  it('returns exact bytes and leaves decoding policy to the caller', async () => {
    const input = new Uint8Array([0x66, 0x80, 0x6f]);
    await expect(readResponseBodyBytesBounded(new Response(input), 3)).resolves.toEqual(input);
    await expect(readResponseBodyBytesBounded(new Response(null), 0))
      .resolves.toEqual(new Uint8Array());
  });

  it('rejects invalid limits before reading the response', async () => {
    await expect(readResponseBodyBytesBounded(new Response('x'), -1))
      .rejects.toThrow('maxBytes must be a non-negative safe integer');
    expect(new BoundedResponseBodyLimitError(1, 2, 'stream').name)
      .toBe('BoundedResponseBodyLimitError');
  });
});
