import { afterEach, expect, it, vi } from 'vitest';
import { SparqlTermValidationError } from '@origintrail-official/dkg-core';
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
    // A query keeps observe mode: the term is rendered, and the aborted call never dispatches it.
    await expect(store.hasGraph('http://ex.org/g^x', { signal: AbortSignal.abort() })).rejects.toThrow();
    // An update refuses the term before anything is built.
    await expect(store.dropGraph('http://ex.org/g^y', { signal: AbortSignal.abort() }))
      .rejects.toThrow(SparqlTermValidationError);

    expect(fetch).not.toHaveBeenCalled();
    expect(observed.counted).toHaveLength(2);
    expect(observed.warnings).toEqual([
      expect.stringContaining('Rendered it in the pre-validation form (observe mode)'),
      expect.stringContaining('Rejected it (reject mode)'),
    ]);
    for (const warning of observed.warnings) expect(warning).not.toMatch(/\bsent\b/i);
  } finally {
    observed.restore();
  }
});
