import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import * as fallbackPlanner from '../src/atomic-asset-group.js';
import * as bulkPlanner from '../src/adapters/bulk-asset-group.js';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const members = [{ graphUri: 'urn:data', metaGraphUri: 'urn:meta', metadataSubject: 'urn:asset',
  graphQuads: [{ graph: 'urn:data', subject: 'urn:s', predicate: 'urn:p', object: '"value"' }],
  metadataQuads: [{ graph: 'urn:meta', subject: 'urn:asset', predicate: 'urn:p', object: '"metadata"' }],
}];

describe('Blazegraph confirmed bulk publication', () => {
  it('uses identical native wire terms for ordinary and staged uploads', async () => {
    const values = ['"001"^^<http://www.w3.org/2001/XMLSchema#integer>', '"café 😀"@fr',
      '"quoted \\"text\\" and \\n newline"', '"\\\\U0001F600"'];
    const quads = values.map((object, i) => ({graph:'urn:data',subject:`urn:é:${i}`,predicate:'urn:p',object}));
    const fetcher = vi.fn().mockImplementation(async (_url, init) =>
      new Response(String(init.body).startsWith('ASK') ? JSON.stringify({boolean:true}) : ''));
    vi.stubGlobal('fetch', fetcher);
    const store = new BlazegraphStore('http://fixture.invalid/sparql');
    try {
      await store.insert(quads);
      const ordinary = String(fetcher.mock.calls[0]![1].body);
      fetcher.mockClear();
      await store.replaceAssetGroup([{...members[0]!,graphQuads:quads,metadataQuads:[]}]);
      const staged = String(fetcher.mock.calls[0]![1].body);
      const terms = (body: string) => body.trimEnd().split('\n').map(line => line.replace(/ <[^>]+> \.$/, ' .'));
      expect(terms(staged)).toEqual(terms(ordinary));
      expect(staged.endsWith('\n')).toBe(true);
      expect([...staged].every(char => char.charCodeAt(0) <= 0x7f)).toBe(true);
      expect(staged).toContain('^^<http://www.w3.org/2001/XMLSchema#integer>');
      expect(staged).toContain('\\u00E9');
    } finally { await store.close(); }
  });

  it.each([false, true])('defers all serialization and uses one admission (fallback=%s)', async fallback => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 1, ackReservedSlots: 0,
      healthReservedSlots: 0, normalReservedSlots: 0, backgroundReservedSlots: 0 });
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const occupying = scheduler.run('normal', 'fixture', async () => { entered(); await blocked; });
    await admitted;
    const plan = vi.spyOn(bulkPlanner, 'buildBulkAssetGroupPlan');
    const fallbackPlan = vi.spyOn(fallbackPlanner, 'buildAtomicAssetGroupUpdate');
    const admissions = vi.spyOn(scheduler, 'run');
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('')).mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(new Response(JSON.stringify({ boolean: true }))).mockResolvedValueOnce(new Response(''));
    vi.stubGlobal('fetch', fetcher);
    const store = new BlazegraphStore('http://fixture.invalid/sparql', { scheduler });
    const selected = fallback ? [{ ...members[0]!, graphQuads: ['1', '01'].map(value => ({
      ...members[0]!.graphQuads[0]!, object: `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
    })) }] : members;
    const work = store.replaceAssetGroup(selected);
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(plan).not.toHaveBeenCalled(); expect(fallbackPlan).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
      release(); await occupying; await work;
      expect(plan).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(fallback ? 1 : 4);
      expect(admissions).toHaveBeenCalledTimes(1); expect(fallbackPlan).toHaveBeenCalledTimes(fallback ? 1 : 0);
    } finally { release(); await occupying; await store.close(); }
  });

  it('selects SPARQL fallback for value aliases before any native upload', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(''));
    vi.stubGlobal('fetch', fetcher);
    const store = new BlazegraphStore('http://fixture.invalid/sparql');
    const [asset] = members;
    try {
      await store.replaceAssetGroup([{ ...asset!, graphQuads: ['1', '01'].map(value => ({
        ...asset!.graphQuads[0]!, object: `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
      })) }]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(new Headers(fetcher.mock.calls[0]![1].headers).get('content-type')).toContain('sparql-update');
    } finally { await store.close(); }
  });

  it.each(['http-error', 'deadline'] as const)('preserves success when cleanup fails: %s', async failure => {
    const request = vi.fn().mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(new Response(JSON.stringify({ boolean: true })))
      .mockImplementationOnce(async (_url, init) => {
        if (failure === 'http-error') return new Response('', { status: 500 });
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      });
    vi.stubGlobal('fetch', request);
    const store = new BlazegraphStore('http://fixture.invalid/sparql', { timeout: 100 });
    try {
      await expect(store.replaceAssetGroup(members)).resolves.toBeUndefined();
      expect(request).toHaveBeenCalledTimes(4);
      const receiptHeaders = new Headers(request.mock.calls[2]![1].headers);
      expect(receiptHeaders.get('x-bigdata-max-query-millis')).toBeTruthy();
      expect(receiptHeaders.get('accept')).toBe('application/sparql-results+json');
      expect(store.getPressureSnapshot()).toMatchObject({ ackInflight: 0, healthInflight: 0, normalInflight: 0, backgroundInflight: 0 });
    } finally { await store.close(); }
  });

  it('cleans only owned staging after a settled publication failure, retaining the first error', async () => {
    const failure = new Error('publication failed');
    const request = vi.fn().mockResolvedValueOnce(new Response('')).mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(new Error('cleanup failed'));
    vi.stubGlobal('fetch', request);
    const store = new BlazegraphStore('http://fixture.invalid/sparql');
    try {
      await expect(store.replaceAssetGroup(members)).rejects.toBe(failure);
      expect(request).toHaveBeenCalledTimes(3);
      const cleanup = String(request.mock.calls[2]![1].body);
      expect(cleanup.split(';').every(line => /^\s*DROP SILENT GRAPH <urn:dkg:/.test(line))).toBe(true);
      expect(cleanup).not.toContain('<urn:data>'); expect(cleanup).not.toContain('<urn:meta>');
    } finally { await store.close(); }
  });

  it('does not convert a missing receipt into success or retry publication', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(new Response(JSON.stringify({ boolean: false }))).mockResolvedValueOnce(new Response(''));
    vi.stubGlobal('fetch', request);
    const store = new BlazegraphStore('http://fixture.invalid/sparql');
    try {
      await expect(store.replaceAssetGroup(members)).rejects.toThrow('receipt missing');
      expect(request).toHaveBeenCalledTimes(4);
    } finally { await store.close(); }
  });
});
