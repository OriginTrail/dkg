// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateQueryCache, postQueryDeduped, listAssertions } from '../src/ui/api.js';
import { listAssertionsPage } from '../src/ui/assertions-page.js';
const response = (bindings: unknown[] = []) => new Response(JSON.stringify({ result: { type: 'bindings', bindings } }));
beforeEach(() => { invalidateQueryCache(); vi.useFakeTimers(); });
afterEach(() => { invalidateQueryCache(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('automatic query budgets', () => {
  it('bounds assertion-page reads that only opt into caching, then allows retry', async () => {
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(response());
    vi.stubGlobal('fetch', fetch); let failure: Error | undefined;
    const pending = listAssertionsPage('cg', 'wm', { includeCounts: false }).catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failure?.message).toContain('timed out'); await pending;
    expect((await listAssertionsPage('cg', 'wm', { includeCounts: false })).items).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('finishes a WM assertion list when its best-effort count never responds', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      const { sparql } = JSON.parse(String(init.body));
      return sparql.includes('COUNT(*)') ? new Promise(() => {}) : Promise.resolve(response([
        { g: 'did:dkg:context-graph:cg/assertion/0x1111111111111111111111111111111111111111/example' },
      ]));
    }));
    let items: Awaited<ReturnType<typeof listAssertions>> | undefined;
    const pending = listAssertions('cg', 'wm').then(result => { items = result; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(items?.map(item => item.name)).toEqual(['example']); await pending;
  });
  it('rejects a response exceeding an explicit byte budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([{ s: 'urn:' + 'x'.repeat(80) }])));
    await expect(postQueryDeduped({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }' }, { maxResponseBytes: 32 }))
      .rejects.toMatchObject({ name: 'QueryResponseLimitError' });
  });
  it('times out and cancels a response whose JSON body never finishes', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"result":')); }, cancel,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream)));
    let failure: Error | undefined;
    const pending = postQueryDeduped({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }' }).catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failure?.message).toContain('timed out'); await pending;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not publish or cache a fetch which completes after its deadline', async () => {
    let finish!: (value: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(response([{ s: 'urn:fresh' }]));
    vi.stubGlobal('fetch', fetch);
    const body = { sparql: 'SELECT ?s WHERE { ?s ?p ?o }', contextGraphId: 'cg' };
    const pending = postQueryDeduped(body, { maxAgeMs: 1000 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).message).toContain('timed out');
    finish(response([{ s: 'urn:late' }]));
    const fresh = await postQueryDeduped(body, { maxAgeMs: 1000 });
    expect(fresh.result?.bindings).toEqual([{ s: 'urn:fresh' }]);
    expect(await postQueryDeduped(body, { maxAgeMs: 1000 })).toEqual(fresh);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('leaves explicit interactive execution without an implicit deadline', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    let settled = false;
    const pending = postQueryDeduped({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }' }, { timeoutMs: null, maxResponseBytes: null }).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false); expect(vi.getTimerCount()).toBe(0);
    finish(response()); await pending; expect(settled).toBe(true);
  });
  it('preserves authorization errors when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await expect(postQueryDeduped({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }' })).rejects.toMatchObject({ status: 403 });
  });
});
