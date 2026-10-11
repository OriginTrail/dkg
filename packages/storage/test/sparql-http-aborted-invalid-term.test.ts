import { afterEach, expect, it, vi } from 'vitest';
import { SparqlHttpStore } from '../src/index.js';
import { observeInvalidSparqlTerms } from './helpers/invalid-sparql-term-observer.js';

// A file of its own, so the once-a-minute warning limit starts fresh.
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('never claims that an aborted statement with an invalid term was sent', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  const observed = observeInvalidSparqlTerms();
  try {
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://aborted.test/query',
      updateEndpoint: 'http://aborted.test/update',
    });
    await expect(store.dropGraph('http://ex.org/g^x', { signal: AbortSignal.abort() })).rejects.toThrow();

    expect(fetch).not.toHaveBeenCalled();
    expect(observed.counted).toHaveLength(1);
    expect(observed.warnings).toEqual([
      expect.stringContaining('Rendered it in the pre-validation form (observe mode)'),
    ]);
    expect(observed.warnings[0]).not.toMatch(/\bsent\b/i);
  } finally {
    observed.restore();
  }
});
