import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OxigraphStore,
  assertSubjectAndInsertPayload,
  buildAtomicSubjectAndInsertUpdate,
  tryReplaceSubjectAndInsertAtomically,
  type Quad,
  type TripleStore,
} from '../src/index.js';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { SparqlHttpStore } from '../src/adapters/sparql-http.js';

const GRAPH = 'urn:test:primary';
const JOB = 'urn:test:job';
const REQUEST = 'urn:test:request';
const quad = (subject: string, object: string, graph = GRAPH): Quad =>
  ({ subject, predicate: 'urn:test:value', object, graph });

describe('atomic subject replacement with additive companions', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('replaces only the job and reasserts missing request rows without deleting extra rows', async () => {
    const store = new OxigraphStore();
    try {
      const old = [quad(JOB, '"old"'), quad(REQUEST, '"extra"'), quad('urn:test:other', '"keep"')];
      await store.insert(old);
      const embedded = (store as unknown as { store: { update: (update: string) => void } }).store;
      const update = vi.spyOn(embedded, 'update');
      const next = [quad(JOB, '"new"')];
      const request = [quad(REQUEST, '"canonical"')];
      await store.replaceSubjectAndInsert(GRAPH, JOB, next, request);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][0]).toBe(buildAtomicSubjectAndInsertUpdate(GRAPH, JOB, next, request));
      expect(await rows(store)).toEqual([
        { s: JOB, o: '"new"' },
        { s: 'urn:test:other', o: '"keep"' },
        { s: REQUEST, o: '"canonical"' },
        { s: REQUEST, o: '"extra"' },
      ]);
      await store.replaceSubjectAndInsert(GRAPH, JOB, next, request);
      expect(await store.countQuads(GRAPH)).toBe(4);
      await store.replaceSubjectAndInsert(GRAPH, JOB, [], []);
      expect(await store.countQuads(GRAPH)).toBe(3);
    } finally { await store.close(); }
  });

  it('round-trips escaped payloads and accepts reserved-IRI references as data', async () => {
    const store = new OxigraphStore();
    const payload = JSON.stringify({ quoted: '"\\\n', unicode: 'µ∆', ref: '<urn:dkg:changelog>' });
    try {
      await store.replaceSubjectAndInsert(
        GRAPH, JOB, [quad(JOB, JSON.stringify(payload))], [quad(REQUEST, '<urn:dkg:changelog>')],
      );
      expect(await rows(store)).toEqual([
        { s: JOB, o: JSON.stringify(payload) }, { s: REQUEST, o: 'urn:dkg:changelog' },
      ]);
    } finally { await store.close(); }
  });

  it.each([
    ['replacement subject', [quad(REQUEST, '"bad"')], []],
    ['replacement graph', [quad(JOB, '"bad"', 'urn:test:foreign')], []],
    ['companion graph', [], [quad(REQUEST, '"bad"', 'urn:test:foreign')]],
    ['companion overlaps replacement', [], [quad(JOB, '"bad"')]],
    ['bracketed companion overlaps replacement', [], [quad(`<${JOB}>`, '"bad"')]],
    ['companion blank subject', [], [quad('_:b', '"bad"')]],
    ['replacement blank object', [quad(JOB, '_:b')], []],
    ['companion blank object', [], [quad(REQUEST, '_:b')]],
    ['companion malformed literal', [], [quad(REQUEST, '"unterminated')]],
    ['replacement malformed literal', [quad(JOB, '"unterminated')], []],
    ['companion unsafe IRI', [], [quad('urn:x> } DROP ALL', '"bad"')]],
  ] as const)('rejects %s before invoking a capability or allowing fallback', async (_label, replacement, inserts) => {
    const mutate = vi.fn(async () => {});
    const store = { replaceSubjectAndInsert: mutate } as unknown as TripleStore;
    await expect(tryReplaceSubjectAndInsertAtomically(store, GRAPH, JOB, [...replacement], [...inserts]))
      .rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
    await expect(tryReplaceSubjectAndInsertAtomically({} as TripleStore, GRAPH, JOB, [...replacement], [...inserts]))
      .rejects.toThrow();
  });

  it('preserves a distinct bracketed companion IRI while replacing only the target', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([quad(JOB, '"old"')]);
      await store.replaceSubjectAndInsert(
        GRAPH, JOB, [quad(JOB, '"new"')], [quad(`<${REQUEST}>`, '"companion"')],
      );
      expect(await rows(store)).toEqual([
        { s: JOB, o: '"new"' }, { s: REQUEST, o: '"companion"' },
      ]);
    } finally { await store.close(); }
  });

  it('rejects unsafe graph and blank replacement subject even for empty groups', () => {
    expect(() => assertSubjectAndInsertPayload('urn:x> }', JOB, [], [])).toThrow();
    expect(() => assertSubjectAndInsertPayload(GRAPH, '_:job', [], [])).toThrow();
  });

  it.each(['blazegraph', 'sparql-http'] as const)('%s dispatches one exact atomic update', async backend => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const store = backend === 'blazegraph'
      ? new BlazegraphStore('http://atomic.test/sparql')
      : new SparqlHttpStore({ queryEndpoint: 'http://atomic.test/sparql', consistencyProfile: 'atomic-update' });
    const next = [quad(JOB, '"new"')];
    const request = [quad(REQUEST, '"canonical"')];
    try {
      await store.replaceSubjectAndInsert(GRAPH, JOB, next, request, { source: 'test.primary', priority: 'background' });
      expect(fetch).toHaveBeenCalledTimes(1);
      const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(init?.body).toBe(buildAtomicSubjectAndInsertUpdate(GRAPH, JOB, next, request));
      expect(init?.method).toBe('POST');
    } finally { await store.close(); }
  });

  it('a best-effort endpoint refuses before any request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const store = new SparqlHttpStore({ queryEndpoint: 'http://atomic.test/sparql' });
    try {
      expect(await tryReplaceSubjectAndInsertAtomically(store, GRAPH, JOB, [], [])).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it.each(['blazegraph', 'sparql-http'] as const)('%s does not replay a rejected mutation', async backend => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('server rejected update', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    const store = backend === 'blazegraph'
      ? new BlazegraphStore('http://atomic.test/sparql')
      : new SparqlHttpStore({ queryEndpoint: 'http://atomic.test/sparql', consistencyProfile: 'atomic-update' });
    try {
      await expect(tryReplaceSubjectAndInsertAtomically(store, GRAPH, JOB, [quad(JOB, '"new"')], []))
        .rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await store.close(); }
  });
});

async function rows(store: TripleStore) {
  const result = await store.query(`SELECT ?s ?o WHERE { GRAPH <${GRAPH}> { ?s <urn:test:value> ?o } } ORDER BY ?s ?o`);
  if (result.type !== 'bindings') throw new Error('Expected bindings');
  return result.bindings;
}
