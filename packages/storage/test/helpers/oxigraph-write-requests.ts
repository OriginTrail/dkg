import { Worker } from 'node:worker_threads';
import oxigraph from 'oxigraph';
import { vi } from 'vitest';
import { OxigraphStore } from '../../src/adapters/oxigraph.js';
import { OxigraphWorkerStore } from '../../src/adapters/oxigraph-worker.js';
import type { ReadGraphWriteOptions } from '../../src/read-graph/adapter-contract.js';
import { authorCommitInput } from '../rfc64-author-commit-cas-harness.js';
import { ASSET, G, META, P, q, S, normalizeRecordedRequests, type RecordedRequest } from './write-request-recording.js';

/**
 * Records what embedded Oxigraph is asked to do for each write method: the
 * engine calls OxigraphStore makes (each `update`, `load`, `add` and
 * single-quad `delete`), and the messages OxigraphWorkerStore posts to its
 * worker (the method and its arguments). Normalized as in
 * `write-request-recording.ts`.
 */
type EmbeddedStore = OxigraphStore | OxigraphWorkerStore;

/** One write call, and the index of the engine call or message in which it changes data. */
export interface OxigraphWriteCase {
  readonly name: string;
  readonly dataRequest: number;
  /** False for a write the worker store does not have. */
  readonly worker?: false;
  readonly run: (store: EmbeddedStore, options?: ReadGraphWriteOptions) => Promise<unknown>;
}

export const OXIGRAPH_WRITE_CASES: readonly OxigraphWriteCase[] = [
  { name: 'insert', dataRequest: 0,
    run: (store, options) => store.insert([q(S, '"one"'), q(S, '"two"')], options) },
  { name: 'delete', dataRequest: 0,
    run: (store, options) => store.delete([q(S, '"one"')], options) },
  { name: 'delete with a blank node', dataRequest: 0,
    run: (store, options) => store.delete([q('_:b1', '"one"')], options) },
  { name: 'deleteByPattern', dataRequest: 0,
    run: (store, options) => store.deleteByPattern({ graph: G, subject: S }, options) },
  { name: 'deleteByPatternWithoutCount', dataRequest: 0,
    run: (store, options) => store.deleteByPatternWithoutCount({ graph: G, predicate: P }, options) },
  { name: 'deleteBySubjectPrefix', dataRequest: 0,
    run: (store, options) => store.deleteBySubjectPrefix(G, 'urn:test:write-requests:s', options) },
  { name: 'dropGraph', dataRequest: 0,
    run: (store, options) => store.dropGraph(G, options) },
  { name: 'update', dataRequest: 0,
    run: (store, options) => store.update(
      `DELETE WHERE { GRAPH <${G}> { <${S}> ?p ?o } }`, { ...options, touchedGraphs: [G] }) },
  { name: 'replaceGraph', dataRequest: 0,
    run: (store, options) => store.replaceGraph(G, [q(S, '"one"'), q(S, '"two"')], options) },
  { name: 'replaceGraph with no quads', dataRequest: 0,
    run: (store, options) => store.replaceGraph(G, [], options) },
  { name: 'replaceAssetGroup', dataRequest: 0, worker: false,
    run: (store, options) => (store as OxigraphStore).replaceAssetGroup([ASSET], options) },
  { name: 'replaceGraphAndSubject', dataRequest: 0,
    run: (store, options) => store.replaceGraphAndSubject(
      G, ASSET.graphQuads, META, ASSET.metadataSubject, ASSET.metadataQuads, options) },
  { name: 'replaceSubject', dataRequest: 0,
    run: (store, options) => store.replaceSubject(G, S, [q(S, '"one"')], options) },
  { name: 'replaceSubjectAndInsert', dataRequest: 0,
    run: (store, options) => store.replaceSubjectAndInsert(
      G, S, [q(S, '"one"')], [q('urn:test:write-requests:s3', '"three"')], options) },
  { name: 'rfc64AuthorCommitCasV1', dataRequest: 0,
    run: (store, options) => store.rfc64AuthorCommitCasV1(authorCommitInput(), options) },
];

/** The quads every case starts from, so that the deletes have something to match. */
const SEED = [q(S, '"one"'), q(S, '"two"'), q('urn:test:write-requests:s2', '"two"'), ...ASSET.metadataQuads];

type EngineCall = 'update' | 'load' | 'add' | 'delete';

/** Run one write on a seeded in-memory OxigraphStore and return the engine calls it made. */
export async function recordOxigraphWrite(
  run: (store: OxigraphStore) => Promise<unknown>,
): Promise<{ requests: string[]; error?: unknown }> {
  const store = new OxigraphStore();
  await store.insert(SEED);
  const calls: RecordedRequest[] = [];
  const engine = oxigraph.Store.prototype;
  const spies = (['update', 'load', 'add', 'delete'] as const satisfies readonly EngineCall[]).map((call) => {
    const original = engine[call] as (...args: unknown[]) => unknown;
    return vi.spyOn(engine, call).mockImplementation(function (this: unknown, ...args: unknown[]) {
      calls.push({ contentType: call, body: String(args[0]) });
      return original.apply(this, args);
    } as never);
  });
  try {
    await run(store);
    return { requests: normalizeRecordedRequests(calls) };
  } catch (error) {
    return { requests: normalizeRecordedRequests(calls), error };
  } finally {
    for (const spy of spies) spy.mockRestore();
    await store.close();
  }
}

/** Run one write on a seeded in-memory OxigraphWorkerStore and return the messages it posted to its worker. */
export async function recordOxigraphWorkerWrite(
  run: (store: OxigraphWorkerStore) => Promise<unknown>,
): Promise<{ requests: string[]; error?: unknown }> {
  const store = new OxigraphWorkerStore();
  await store.insert(SEED);
  const messages: RecordedRequest[] = [];
  const original = Worker.prototype.postMessage;
  const spy = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message: unknown, ...rest: unknown[]) {
    const { method, args } = message as { method: string; args: unknown[] };
    messages.push({ contentType: method, body: JSON.stringify(args) });
    return (original as (...a: unknown[]) => void).call(this, message, ...rest);
  } as never);
  try {
    await run(store);
    return { requests: normalizeRecordedRequests(messages) };
  } catch (error) {
    return { requests: normalizeRecordedRequests(messages), error };
  } finally {
    spy.mockRestore();
    await store.close();
  }
}
