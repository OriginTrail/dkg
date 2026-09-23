// Long Knowledge Asset mutations (vm/publish, swm/share, wm/import-file) wait out the
// publisher's storage-ACK window, so they get their own deadline, and a response that
// never arrives is an unknown outcome rather than a failure: the node keeps working
// after the page stops waiting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  importFile,
  knowledgeAssetPublish,
  knowledgeAssetShare,
  outcomeUnknownPublishNote,
  OutcomeUnknownError,
  publishAssertionsToVm,
} from '../src/ui/api.js';
import { HttpError, LONG_MUTATION_TIMEOUT_MS } from '../src/ui/http.js';

// A daemon that answers only when a test says so. Until then the request stays open
// and honours its abort signal the way fetch does.
function pendingDaemon() {
  const requests: Array<{ url: string; respond: (status: number, body: unknown) => void }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('The operation was aborted.', 'AbortError')),
        { once: true },
      );
      requests.push({
        url: String(input),
        respond: (status, body) => resolve(new Response(JSON.stringify(body), { status })),
      });
    })) as typeof fetch;
  return requests;
}

describe('long Knowledge Asset mutations', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('keeps waiting for a slow publish and returns its answer', async () => {
    const requests = pendingDaemon();
    const result = knowledgeAssetPublish('cg-1', 'notes');

    await vi.advanceTimersByTimeAsync(LONG_MUTATION_TIMEOUT_MS - 1_000);
    requests[0].respond(200, { kaId: '7', status: 'confirmed' });

    await expect(result).resolves.toEqual({ kaId: '7', status: 'confirmed' });
    expect(requests[0].url).toBe('/api/knowledge-assets/notes/vm/publish');
  });

  it.each([
    ['publish', () => knowledgeAssetPublish('cg-1', 'notes'), 'Publishing "notes"'],
    ['share', () => knowledgeAssetShare('cg-1', 'notes'), 'Sharing "notes"'],
    [
      'import',
      () => importFile('notes', 'cg-1', new File(['# doc'], 'doc.md', { type: 'text/markdown' })),
      'Importing "doc.md" into "notes"',
    ],
  ])('reports a %s with no answer by the deadline as outcome unknown', async (_label, run, action) => {
    pendingDaemon();
    const settled = run().then(
      () => { throw new Error('expected the mutation to time out'); },
      (err: unknown) => err,
    );

    await vi.advanceTimersByTimeAsync(LONG_MUTATION_TIMEOUT_MS);

    const err = await settled;
    expect(err).toBeInstanceOf(OutcomeUnknownError);
    expect((err as Error).message).toContain(`${action} got no response within 4 minutes`);
    expect((err as Error).message).toContain("Check the Knowledge Asset's history before retrying");
  });

  it('keeps a daemon error answer as an HttpError', async () => {
    const requests = pendingDaemon();
    const result = knowledgeAssetPublish('cg-1', 'notes');
    requests[0].respond(409, { error: 'Knowledge Asset is not publish-ready.' });

    const err = await result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 409, message: 'Knowledge Asset is not publish-ready.' });
  });

  it('counts an unknown publish in a batch as neither published nor failed', async () => {
    const requests = pendingDaemon();
    const batch = publishAssertionsToVm('cg-1', [{ name: 'a' }, { name: 'b', subGraph: 'sg1' }]);

    await vi.advanceTimersByTimeAsync(LONG_MUTATION_TIMEOUT_MS);
    expect(requests).toHaveLength(2);
    requests[1].respond(200, { kaId: '0xb', status: 'confirmed', txHash: '0xtxb' });

    const result = await batch;
    expect(result.published).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.outcomeUnknown).toHaveLength(1);
    expect(result.outcomeUnknown?.[0]).toMatchObject({ name: 'a' });
    expect(outcomeUnknownPublishNote(result)).toBe(
      '1 knowledge asset: publish outcome unknown — the node may still publish it. '
      + 'Check the history before publishing again.',
    );
  });

  it('writes no outcome note for a batch without unknown publishes', () => {
    expect(outcomeUnknownPublishNote({})).toBeUndefined();
    expect(outcomeUnknownPublishNote({
      outcomeUnknown: [{ name: 'a', error: 'x' }, { name: 'b', error: 'y' }],
    })).toContain('2 knowledge assets: publish outcome unknown — the node may still publish them.');
  });
});
