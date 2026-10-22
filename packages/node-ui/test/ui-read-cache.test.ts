// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CachedRead, ReadCache, UI_READ_MAX_AGE_MS } from '../src/ui/lib/read-cache.js';
import { fetchContextGraphs, invalidateQueryCache, postQueryDeduped, subscribeToContextGraph, submitJoinRequest } from '../src/ui/api.js';

const body = (cg = 'cg-a') => ({ sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 50', contextGraphId: cg });
const read = { maxAgeMs: UI_READ_MAX_AGE_MS };
const response = (value = 'urn:one') => new Response(JSON.stringify({ result: { type: 'bindings', bindings: [{ s: value }] } }));

beforeEach(() => { invalidateQueryCache(); window.__DKG_TOKEN__ = 'session-a'; });
afterEach(() => { delete window.__DKG_TOKEN__; invalidateQueryCache(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('bounded read cache', () => {
  it('releases a synchronous failed loader and can retry', async () => {
    const owner = new CachedRead<string>();
    await expect(owner.run('key', { maxAgeMs: 1000 }, () => { throw new Error('failed'); })).rejects.toThrow('failed');
    await expect(owner.run('key', { maxAgeMs: 1000 }, async () => 'fresh')).resolves.toBe('fresh');
  });
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
  it('keeps another context in flight when only one context is invalidated', async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetch = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve)));
    vi.stubGlobal('fetch', fetch);
    const a = postQueryDeduped(body(), read); const b = postQueryDeduped(body('cg-b'), read);
    invalidateQueryCache('cg-a');
    const joined = postQueryDeduped(body('cg-b'), read);
    pending[0](response('old-a')); pending[1](response('b'));
    await a; expect(await joined).toEqual(await b);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['query', 'graph list'])('keeps the replacement %s request registered after an invalidated completion', async kind => {
    const pending: Array<(response: Response) => void> = [];
    const fetch = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve)));
    vi.stubGlobal('fetch', fetch);
    const load = kind === 'query' ? () => postQueryDeduped(body(), read) : () => fetchContextGraphs();
    const result = (id: string) => kind === 'query' ? response(id)
      : new Response(JSON.stringify({ contextGraphs: [{ id }] }));
    const old = load();
    invalidateQueryCache('cg-a');
    const replacement = load();
    pending[0](result('old')); await old;
    const joined = load();
    expect(fetch).toHaveBeenCalledTimes(2);
    pending[1](result('new'));
    const fresh = await replacement;
    expect(await joined).toEqual(fresh); expect(await load()).toEqual(fresh);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['query', 'graph list'])('does not let an invalidated %s authorization failure evict its replacement', async kind => {
    const pending: Array<(response: Response) => void> = [];
    const fetch = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve)));
    vi.stubGlobal('fetch', fetch);
    const load = kind === 'query' ? () => postQueryDeduped(body(), read) : () => fetchContextGraphs();
    const old = load(); const failure = expect(old).rejects.toMatchObject({ status: 403 });
    invalidateQueryCache('cg-a'); const replacement = load();
    pending[0](new Response('{"error":"revoked"}', { status: 403 })); await failure;
    const joined = load(); expect(fetch).toHaveBeenCalledTimes(2);
    pending[1](kind === 'query' ? response('new') : new Response('{"contextGraphs":[{"id":"new"}]}'));
    const fresh = await replacement;
    expect(await joined).toEqual(fresh); expect(await load()).toEqual(fresh);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('lets explicit console queries opt out while automatic reads have a deadline', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
    await postQueryDeduped(body(), { timeoutMs: null, maxResponseBytes: null });
    expect(vi.getTimerCount()).toBe(0);
    await postQueryDeduped(body());
    expect(fetch.mock.calls[1][1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(['subscribe', 'join'])('invalidates a pre-mutation list after successful %s without SSE', async action => {
    let joined = false;
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/list')) return new Response(JSON.stringify({ contextGraphs: joined ? [{ id: 'cg-new' }] : [] }));
      joined = true; return new Response('{"success":true,"approved":true}');
    });
    vi.stubGlobal('fetch', fetch);
    expect((await fetchContextGraphs()).contextGraphs).toHaveLength(0);
    if (action === 'subscribe') await subscribeToContextGraph('cg-new');
    else await submitJoinRequest('cg-new', { delegation: {} as any });
    expect((await fetchContextGraphs()).contextGraphs).toEqual([{ id: 'cg-new' }]);
    expect(fetch.mock.calls.filter(([url]) => url.includes('/list'))).toHaveLength(2);
  });
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
