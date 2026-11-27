import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { openSnapshotNativeStore } from '../src/snapshot-native-store.js';

vi.mock('../src/snapshot-native-process.js', () => ({ startSnapshotNativeProcess: vi.fn(async () => ({
  stop: async () => {}, assertRunning: () => {},
})) }));
afterEach(() => vi.unstubAllGlobals());

it('serializes the actual private store, including response bodies, through normal and control reads', async () => {
  let entered!: () => void, finish!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const json = JSON.stringify({ head: { vars: ['p', 'o'] }, results: { bindings: [
    { p: { type: 'uri', value: 'urn:p' }, o: { type: 'literal', value: 'v' } },
  ] } });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/status')) return new Response('ready');
    calls++;
    if (calls !== 1) return new Response(json);
    return new Response(new ReadableStream({ async start(controller) {
      entered(); await release; controller.enqueue(new TextEncoder().encode(json)); controller.close();
    } }));
  }));
  const store = await openSnapshotNativeStore({ java: '/fixture/java', jar: '/fixture.jar',
    properties: '/fixture.properties', folder: '/fixture', log: '/fixture.log', signal: new AbortController().signal });
  const query = 'SELECT ?p ?o WHERE { <urn:asset> ?p ?o }';
  const first = store.query(query); await waiting;
  const second = store.query(query, { controlQueue: 'publisher' });
  try { await setImmediate(); expect(calls).toBe(1); } finally { finish(); await Promise.all([first, second]); await store.close(); }
  expect(calls).toBe(2); expect(store.getPressureSnapshot().maxConcurrent).toBe(1);
});
