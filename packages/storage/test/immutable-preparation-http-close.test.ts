import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTripleStore } from '../src/index.js';

it.each(['raw', 'index', 'literal', 'composed'] as const)
('lets %s HTTP shutdown abort a dispatched mutation and reuses the closed store', async layout => {
  const root = await mkdtemp(join(tmpdir(), 'dkg-http-preparation-close-'));
  let hold = true, dispatched = false, aborted = false, release: (() => void) | undefined;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (!hold) return new Response(null, { status: 204 });
    dispatched = true;
    return new Promise<Response>((resolve, reject) => {
      const signal = init!.signal!;
      const onAbort = () => { aborted = true; signal.removeEventListener('abort', onAbort); reject(signal.reason); };
      release = () => { signal.removeEventListener('abort', onAbort); resolve(new Response(null, { status: 204 })); };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  });
  const store = await createTripleStore({ backend: 'sparql-http', changelog: false,
    options: { queryEndpoint: 'http://example.invalid/query', updateEndpoint: 'http://example.invalid/update', timeout: 60_000 },
    graphSetIndex: layout === 'index' || layout === 'composed',
    ...(layout === 'literal' || layout === 'composed'
      ? { largeLiteralStorage: { directory: root, thresholdBytes: 64 } } : {}),
  });
  const quad = { graph: 'urn:http-close', subject: 'urn:accepted', predicate: 'urn:value', object: '"small"' };
  const accepted = store.insert([quad]).then(() => 'ack', () => 'rejected');
  let closing: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(dispatched).toBe(true));
    closing = store.close();
    if (layout !== 'raw') expect(store.close()).toBe(closing);
    const late = store.insert([{ ...quad, subject: 'urn:late' }]).then(() => false, () => true);
    await expect(late).resolves.toBe(true);
    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 250, interval: 10 });
    await closing;
    await expect(accepted).resolves.toBe('rejected');
    hold = false;
    await expect(store.insert([{ ...quad, subject: 'urn:after-close' }])).resolves.toBeUndefined();
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
  } finally {
    hold = false; release?.();
    await Promise.allSettled([accepted, closing]);
    await store.close(); fetch.mockRestore(); await rm(root, { recursive: true, force: true });
  }
});
