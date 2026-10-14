import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@origintrail-official/dkg-core';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import * as fallbackPlanner from '../src/atomic-asset-group.js';
import * as bulkPlanner from '../src/adapters/bulk-asset-group.js';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const members = [{ graphUri: 'urn:data', metaGraphUri: 'urn:meta', metadataSubject: 'urn:asset',
  graphQuads: [{ graph: 'urn:data', subject: 'urn:s', predicate: 'urn:p', object: '"value"' }],
  metadataQuads: [{ graph: 'urn:meta', subject: 'urn:asset', predicate: 'urn:p', object: '"metadata"' }],
}];

describe('Blazegraph confirmed bulk publication', () => {
  it('keeps native staging independent of consensus hashing', () => {
    const hashing = vi.spyOn(core, 'canonicalizeObjectTermForHash').mockImplementation(() => {
      throw new Error('Storage strategy must not invoke the Merkle canonicalizer');
    });
    const graphQuads = ['1', '2'].map(value => ({ ...members[0]!.graphQuads[0]!,
      object: `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
    }));
    expect(bulkPlanner.buildBulkAssetGroupPlan([{ ...members[0]!, graphQuads }])).not.toBeNull();
    expect(hashing).not.toHaveBeenCalled();
  });

  it.each([
    ['"one"', '"\\u006fne"^^<http://www.w3.org/2001/XMLSchema#string>'],
    ['"one"@en', '"one"@EN'],
    ['"true"^^<http://www.w3.org/2001/XMLSchema#boolean>', '"1"^^<http://www.w3.org/2001/XMLSchema#boolean>'],
    ['"1.0"^^<http://www.w3.org/2001/XMLSchema#decimal>', '"01.00"^^<http://www.w3.org/2001/XMLSchema#decimal>'],
    ['"1e0"^^<http://www.w3.org/2001/XMLSchema#double>', '"1.0"^^<http://www.w3.org/2001/XMLSchema#double>'],
    ['"1.00000001"^^<http://www.w3.org/2001/XMLSchema#float>', '"1"^^<http://www.w3.org/2001/XMLSchema#float>'],
    ['"2026-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', '"2026-01-01T00:00:00+00:00"^^<http://www.w3.org/2001/XMLSchema#dateTime>'],
  ])('uses fallback for potentially aliased staging terms %s / %s', (left, right) => {
    const graphQuads = [left, right].map(object => ({ ...members[0]!.graphQuads[0]!, object }));
    expect(bulkPlanner.buildBulkAssetGroupPlan([{ ...members[0]!, graphQuads }])).toBeNull();
  });

  it('retains native staging for repeated identical and distinct string terms', () => {
    const graphQuads = ['"one"', '"one"', '"two"'].map(object => ({ ...members[0]!.graphQuads[0]!, object }));
    const plan = bulkPlanner.buildBulkAssetGroupPlan([{ ...members[0]!, graphQuads }]);
    expect(plan).not.toBeNull();
    expect(plan!.update).toContain('FILTER(?n0 = 2)');
  });

  it('uses conservative fallback for multiple unmodeled XSD values at one subject/predicate', () => {
    const graphQuads = ['2026-01-01', '2026-01-02'].map(value => ({ ...members[0]!.graphQuads[0]!,
      object: `"${value}"^^<http://www.w3.org/2001/XMLSchema#date>`,
    }));
    expect(bulkPlanner.buildBulkAssetGroupPlan([{ ...members[0]!, graphQuads }])).toBeNull();
    expect(bulkPlanner.buildBulkAssetGroupPlan([{ ...members[0]!, graphQuads: [graphQuads[0]!] }])).not.toBeNull();
  });

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
      const contentType = new Headers(fetcher.mock.calls[0]![1].headers).get('content-type');
      expect(contentType).toBe('text/x-nquads');
      fetcher.mockClear();
      await store.replaceAssetGroup([{...members[0]!,graphQuads:quads,metadataQuads:[]}]);
      const staged = String(fetcher.mock.calls[0]![1].body);
      expect(new Headers(fetcher.mock.calls[0]![1].headers).get('content-type')).toBe(contentType);
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

  it('publishes a bounded group whose native escaping exceeds the upload allowance', async () => {
    const target = new OxigraphStore();
    const assets = [1, 2].map(id => ({ graphUri: `urn:data:${id}`, metaGraphUri: 'urn:meta', metadataSubject: `urn:asset:${id}`,
      graphQuads: Array.from({ length: 66 }, (_, n) => ({ graph: `urn:data:${id}`, subject: `urn:s:${id}:${n}`,
        predicate: 'urn:p', object: JSON.stringify('\u007f'.repeat(60_000)) })), metadataQuads: [],
    }));
    const fetcher = vi.fn(async (_url, init) => {
      expect(new Headers(init.headers).get('content-type')).toContain('sparql-update');
      expect(Buffer.byteLength(init.body)).toBeLessThanOrEqual(fallbackPlanner.ATOMIC_ASSET_GROUP_MAX_UPDATE_BYTES);
      await target.update(init.body); return new Response('');
    });
    vi.stubGlobal('fetch', fetcher);
    const store = new BlazegraphStore('http://fixture.invalid/sparql');
    try {
      await store.replaceAssetGroup(assets);
      expect(fetcher).toHaveBeenCalledTimes(1);
      for (const asset of assets) expect(await target.countQuads(asset.graphUri)).toBe(66);
    } finally { await store.close(); await target.close(); }
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

  it('preserves a receipt read error when cleanup also fails, without replay', async () => {
    const failure = new Error('receipt read failed');
    const request = vi.fn().mockResolvedValueOnce(new Response('')).mockResolvedValueOnce(new Response(''))
      .mockRejectedValueOnce(failure).mockRejectedValueOnce(new Error('cleanup failed'));
    vi.stubGlobal('fetch', request);
    const store = new BlazegraphStore('http://fixture.invalid/sparql');
    try {
      await expect(store.replaceAssetGroup(members)).rejects.toBe(failure);
      expect(request).toHaveBeenCalledTimes(4);
      expect(String(request.mock.calls[2]![1].body)).toMatch(/^ASK/);
      expect(String(request.mock.calls[3]![1].body)).toMatch(/^DROP SILENT GRAPH/);
    } finally { await store.close(); }
  });
});
