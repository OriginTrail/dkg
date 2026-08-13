/**
 * The shared bounded response reader, and the identity of its refusal.
 *
 * `readResponseTextBounded` is the cap for every fetch-dispatched store — sparql-http and
 * blazegraph both route through it — and it refuses in TWO places: a Content-Length
 * preflight before any body is read, and a running total while the stream arrives. Only
 * the streaming half had coverage, because every fixture elsewhere builds a body without
 * a declared length, so deleting the preflight left every suite green.
 *
 * That matters beyond the missing branch. The preflight is what makes the cap a REFUSAL
 * rather than a late detection: without it an oversized answer is buffered up to the bound
 * before anything objects. And the refusal's IDENTITY is a contract — the legacy
 * agent-profile gate read degrades to "undecided" on it instead of dropping a durable-sync
 * page, and it recognises it through the canonical predicate rather than a message.
 */
import { describe, expect, it } from 'vitest';

import {
  isStoreResponseTooLargeErrorV1,
  readResponseTextBounded,
  StoreResponseTooLargeError,
  STORE_RESPONSE_TOO_LARGE_CODE,
} from '../src/http-response-limit.js';

/** A body that arrives in chunks and declares no length, so the preflight cannot see it. */
function streamedResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream);
}

const thrown = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
};

describe('readResponseTextBounded', () => {
  // The discriminator is the SMALL body behind the LARGE declared length. With the
  // preflight in place the declaration alone refuses the response; with it deleted the
  // three actual bytes sail under the cap and the read succeeds. A fixture whose body was
  // genuinely oversized would pass either way and would be testing the streaming branch
  // over again.
  it('refuses on the declared length alone, before reading a body that would fit', async () => {
    const response = new Response('abc', { headers: { 'content-length': '999' } });

    const refusal = await thrown(() => readResponseTextBounded(response, 10));

    expect(refusal).toBeInstanceOf(StoreResponseTooLargeError);
    expect((refusal as StoreResponseTooLargeError).maxBytes).toBe(10);
    expect(Number((refusal as StoreResponseTooLargeError).actualBytes)).toBe(999);
  });

  // Identity at the SOURCE. Every other suite either constructs this error itself or fakes
  // its shape, so nothing pinned that the reader's own refusal satisfies the predicate the
  // gate read discriminates on — the class could have stopped carrying the code with all
  // of them green.
  it('raises a refusal that satisfies the canonical predicate and carries the code', async () => {
    const refusal = await thrown(() => readResponseTextBounded(
      new Response('abc', { headers: { 'content-length': '999' } }),
      10,
    ));

    expect(isStoreResponseTooLargeErrorV1(refusal)).toBe(true);
    expect((refusal as { code?: unknown }).code).toBe(STORE_RESPONSE_TOO_LARGE_CODE);
  });

  it('refuses a streamed body that crosses the bound without declaring a length', async () => {
    const refusal = await thrown(() => readResponseTextBounded(streamedResponse('abcdefghijk'), 5));

    expect(refusal).toBeInstanceOf(StoreResponseTooLargeError);
    expect(isStoreResponseTooLargeErrorV1(refusal)).toBe(true);
  });

  it('returns a body that fits, so the cases above are refusals rather than a broken read', async () => {
    await expect(readResponseTextBounded(streamedResponse('abcde'), 5)).resolves.toBe('abcde');
  });
});
