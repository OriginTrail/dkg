// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadCache, UI_READ_MAX_AGE_MS } from '../src/ui/lib/read-cache.js';
import { fetchContextGraphs, invalidateQueryCache, postQueryDeduped } from '../src/ui/api.js';

const body = (cg = 'cg-a') => ({ sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 50', contextGraphId: cg });
const read = { maxAgeMs: UI_READ_MAX_AGE_MS };
const response = (value = 'urn:one') => new Response(JSON.stringify({ result: { type: 'bindings', bindings: [{ s: value }] } }));

beforeEach(() => { invalidateQueryCache(); window.__DKG_TOKEN__ = 'session-a'; });
afterEach(() => { delete window.__DKG_TOKEN__; invalidateQueryCache(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('bounded read cache', () => {
  it('evicts least-recently-used entries and refuses oversized results', () => {
    const cache = new ReadCache<string>(24, 2);
    cache.set('a', 'A'); cache.set('b', 'B'); cache.get('a', 1000); cache.set('c', 'C');
    expect(cache.get('b', 1000)).toBeUndefined();
    expect(cache.get('a', 1000)).toBe('A');
    cache.set('large', 'x'.repeat(100));
    expect(cache.get('large', 1000)).toBeUndefined();
    const bytes = new ReadCache<string>(12, 100);
    bytes.set('a', '123'); bytes.set('b', '456');
    expect(bytes.get('a', 1000)).toBeUndefined();
    expect(bytes.get('b', 1000)).toBe('456');
  });
  it('expires entries and invalidates only the changed scope', () => {
    vi.useFakeTimers();
    const cache = new ReadCache<string>();
    cache.set('a', 'A', 'cg-a'); cache.set('b', 'B', 'cg-b');
    cache.invalidate('cg-a');
    expect(cache.get('a', 1000)).toBeUndefined();
    expect(cache.get('b', 1000)).toBe('B');
    vi.advanceTimersByTime(1000);
    expect(cache.get('b', 1000)).toBeUndefined();
  });
});

describe('scoped UI reads', () => {
  it('coalesces concurrent reads and reuses them on tab return, with TTL and scoped refresh', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
    await Promise.all([postQueryDeduped(body(), read), postQueryDeduped(body(), read)]);
    await postQueryDeduped(body(), read);
    expect(fetch).toHaveBeenCalledTimes(1);
    await postQueryDeduped(body('cg-b'), read);
    invalidateQueryCache('cg-a');
    await postQueryDeduped(body(), read); await postQueryDeduped(body('cg-b'), read);
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(UI_READ_MAX_AGE_MS);
    await postQueryDeduped(body(), read);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('keeps ordinary query execution fresh and never caches SPARQL updates', async () => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
    await postQueryDeduped(body()); await postQueryDeduped(body());
    expect(fetch).toHaveBeenCalledTimes(2);
    await postQueryDeduped(body(), read);
    const update = { ...body(), sparql: 'INSERT DATA { <urn:s> <urn:p> <urn:o> }' };
    await postQueryDeduped(update, read); await postQueryDeduped(update, read);
    await postQueryDeduped(body(), read);
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it('never shares cached data between authentication sessions', async () => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
    await postQueryDeduped(body(), read);
    window.__DKG_TOKEN__ = 'session-b';
    await postQueryDeduped(body(), read);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer session-b');
  });
  it('rejects a response from a session which changed while the request was pending', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolve = r; })));
    const pending = postQueryDeduped(body(), read);
    window.__DKG_TOKEN__ = 'session-b'; resolve(response());
    await expect(pending).rejects.toMatchObject({ status: 401 });
  });
  it('does not cache errors or a read overtaken by an invalidation', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }))
      .mockResolvedValueOnce(new Response('{"error":"temporary"}', { status: 503 }))
      .mockImplementation(async () => response('urn:new'));
    vi.stubGlobal('fetch', fetch);
    const pending = postQueryDeduped(body(), read);
    invalidateQueryCache('cg-a'); resolve(response('urn:old')); await pending;
    await expect(postQueryDeduped(body(), read)).rejects.toMatchObject({ status: 503 });
    const latest = await postQueryDeduped(body(), read);
    expect(latest.result?.bindings?.[0].s).toBe('urn:new');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('reuses the graph list, but a mutation signal or session change invalidates it', async () => {
    const fetch = vi.fn(async () => new Response('{"contextGraphs":[{"id":"cg-a"}]}'));
    vi.stubGlobal('fetch', fetch);
    await fetchContextGraphs(); await fetchContextGraphs();
    expect(fetch).toHaveBeenCalledTimes(1);
    invalidateQueryCache('cg-a'); await fetchContextGraphs();
    window.__DKG_TOKEN__ = 'session-b'; await fetchContextGraphs();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
