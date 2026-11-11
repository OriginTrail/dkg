import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import oxigraph from 'oxigraph';
import { afterAll, expect, it, vi } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { OxigraphWorkerStore } from '../src/adapters/oxigraph-worker.js';
import { q, readGraphWriteSuite, type SentRequests } from './_helpers/read-graph-write-suite.js';

/**
 * OxigraphStore and OxigraphWorkerStore send a write's read-graph operations
 * in the same engine update as its data change (see
 * `_helpers/read-graph-write-suite.ts`).
 */

/** Records the text of every update and load OxigraphStore sends its engine. */
function sentToEngine(): SentRequests {
  const sent: string[] = [];
  const spies: { mockRestore(): void }[] = [];
  return {
    start() {
      const engine = oxigraph.Store.prototype;
      for (const call of ['update', 'load'] as const) {
        const original = engine[call] as (...args: unknown[]) => unknown;
        spies.push(vi.spyOn(engine, call).mockImplementation(function (this: unknown, ...args: unknown[]) {
          sent.push(String(args[0]));
          return original.apply(this, args);
        } as never));
      }
    },
    sent: () => sent.splice(0),
    stop: () => { for (const spy of spies.splice(0)) spy.mockRestore(); },
  };
}

/** Records every message OxigraphWorkerStore posts to its worker, as the strings its arguments hold. */
function sentToWorker(): SentRequests {
  const sent: string[] = [];
  let spy: { mockRestore(): void } | undefined;
  const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(strings)
      : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  return {
    start() {
      const original = Worker.prototype.postMessage as (...args: unknown[]) => void;
      spy = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message: unknown, ...rest: unknown[]) {
        sent.push(strings((message as { args?: unknown }).args).join('\n'));
        return original.call(this, message, ...rest);
      } as never);
    },
    sent: () => sent.splice(0),
    stop: () => spy?.mockRestore(),
  };
}

const dir = mkdtempSync(join(tmpdir(), 'dkg-read-graph-writes-'));
const persistPath = join(dir, 'store.nq');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

readGraphWriteSuite({
  name: 'OxigraphStore (embedded, persisted)',
  adapter: 'oxigraph',
  open: async () => new OxigraphStore(persistPath),
  requests: sentToEngine(),
}, ({ store, inScenario }) => {
  it('a store reopened from what it flushed holds the same read graph', () => inScenario(async (s) => {
    await s.maintained(s.reference(s.G1), (o) => store().replaceGraph(s.G1, [q('r', 'reopened', s.G1)], o));
    await store().flush();
    const reopened = new OxigraphStore(persistPath, { readOnly: true });
    try {
      const rows = async (query: string) => {
        const result = await reopened.query(query);
        if (result.type !== 'bindings') throw new Error('Expected bindings');
        return result.bindings.map((b) => `${b.s} ${b.p} ${b.o}`).sort();
      };
      const readGraph = await rows(`SELECT ?s ?p ?o WHERE { GRAPH <${s.R}> { ?s ?p ?o } }`);
      expect(readGraph).toEqual(await s.readGraph());
      expect(readGraph).toEqual(await rows(
        `SELECT DISTINCT ?s ?p ?o WHERE { GRAPH ?h { ?s ?p ?o } FILTER(STRSTARTS(STR(?h), "${s.member}")) }`));
    } finally {
      await reopened.close();
    }
  }));
});

readGraphWriteSuite({
  name: 'OxigraphWorkerStore',
  adapter: 'oxigraph',
  open: async () => new OxigraphWorkerStore(),
  requests: sentToWorker(),
  replaceAssetGroup: false,
});
