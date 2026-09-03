import { describe, expect, it } from 'vitest';
import { readModelResponseTextBounded } from '../src/model-response.js';

describe('bounded local-model responses', () => {
  it('cancels the body when Content-Length exceeds the configured limit', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers: { 'Content-Length': '129' },
    });

    await expect(readModelResponseTextBounded(response, 128)).rejects.toThrow(
      'Local LLM response exceeds 128 bytes',
    );
    expect(cancelled).toBe(true);
  });

  it('cancels a streamed body as soon as received bytes exceed the limit', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(129));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readModelResponseTextBounded(new Response(body), 128)).rejects.toThrow(
      'Local LLM response exceeds 128 bytes',
    );
    expect(cancelled).toBe(true);
  });
});
