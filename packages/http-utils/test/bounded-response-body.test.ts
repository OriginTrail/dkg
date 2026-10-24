import { describe, expect, it, vi } from 'vitest';
import {
  BoundedResponseBodyLimitError,
  consumeResponseBodyChunks,
  readResponseBodyBytesBounded,
} from '../src/index.js';

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

  it('supports incremental consumers and cancels when the consumer rejects', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(consumeResponseBodyChunks(new Response(body), 10, () => {
      throw new Error('consumer failed');
    })).rejects.toThrow('consumer failed');
    expect(cancelled).toBe(true);
  });

  it('awaits each asynchronous consumer before reading the next chunk', async () => {
    let releaseFirst!: () => void;
    const firstConsumed = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(Uint8Array.of(1));
        else if (pulls === 2) controller.enqueue(Uint8Array.of(2));
        else controller.close();
      },
    }, { highWaterMark: 0 });
    const consumed: number[] = [];
    const pending = consumeResponseBodyChunks(new Response(body), 10, async (chunk) => {
      consumed.push(chunk[0]!);
      if (chunk[0] === 1) await firstConsumed;
    });

    await vi.waitFor(() => expect(consumed).toEqual([1]));
    expect(pulls).toBe(1);
    releaseFirst();
    await expect(pending).resolves.toBe(2);
    expect(consumed).toEqual([1, 2]);
  });

  it('cancels an open stream before surfacing an asynchronous consumer rejection', async () => {
    const consumerFailure = new Error('async consumer failed');
    const events: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
      },
      cancel(reason) {
        expect(reason).toBe(consumerFailure);
        events.push('cancelled');
      },
    });

    const failure = consumeResponseBodyChunks(new Response(body), 10, async () => {
      await Promise.resolve();
      throw consumerFailure;
    }).catch((error: unknown) => {
      events.push('rejected');
      throw error;
    });
    await expect(failure).rejects.toBe(consumerFailure);
    expect(events).toEqual(['cancelled', 'rejected']);
  });

  it('rejects invalid limits before reading the response', async () => {
    let pulled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() {
        pulled = true;
      },
    }, { highWaterMark: 0 }));
    await expect(readResponseBodyBytesBounded(response, undefined as unknown as number))
      .rejects.toThrow('maxBytes must be a non-negative safe integer');
    await expect(readResponseBodyBytesBounded(response, -1))
      .rejects.toThrow('maxBytes must be a non-negative safe integer');
    expect(pulled).toBe(false);
    expect(new BoundedResponseBodyLimitError(1, 2, 'stream').name)
      .toBe('BoundedResponseBodyLimitError');
  });
});
