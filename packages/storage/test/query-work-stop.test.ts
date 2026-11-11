import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OxigraphStore,
  QueryWorkStoppedError,
  isQueryWorkStoppedError,
  remainingWorkMs,
} from '../src/index.js';
import { boundByWorkDeadline, workStoppedError } from '../src/query-work-stop.js';
import { cancelBlazegraphQuery, withBlazegraphQueryId } from '../src/adapters/blazegraph-read-stop.js';

describe('work deadline helpers', () => {
  it('recognises a stopped read structurally', () => {
    const cause = new Error('limit');
    const stopped = new QueryWorkStoppedError('oxigraph-worker', 'stopped', cause);
    expect(stopped).toMatchObject({ code: 'QUERY_WORK_STOPPED', backend: 'oxigraph-worker', outcome: 'stopped', cause });
    expect(stopped.message).toContain('stopped a read');
    expect(new QueryWorkStoppedError('blazegraph', 'not_started', cause).message).toContain('did not start');
    expect(isQueryWorkStoppedError(stopped)).toBe(true);
    expect(isQueryWorkStoppedError({ code: 'QUERY_WORK_STOPPED', backend: 'x', outcome: 'not_started' })).toBe(true);
    for (const other of [null, undefined, 'QUERY_WORK_STOPPED', cause, { code: 'QUERY_WORK_STOPPED', backend: 'x', outcome: 'maybe' },
      { code: 'QUERY_WORK_STOPPED', outcome: 'stopped' }]) {
      expect(isQueryWorkStoppedError(other)).toBe(false);
    }
  });

  it('measures what is left of a deadline, never below 1 ms', () => {
    expect(remainingWorkMs(undefined)).toBeUndefined();
    expect(remainingWorkMs(Number.NaN)).toBeUndefined();
    expect(remainingWorkMs(performance.now() - 5_000)).toBe(1);
    const left = remainingWorkMs(performance.now() + 2_000)!;
    expect(left).toBeGreaterThan(1_900);
    expect(left).toBeLessThanOrEqual(2_000);
  });

  it('only ever shortens a store bound', () => {
    expect(boundByWorkDeadline(30_000, undefined)).toBe(30_000);
    expect(boundByWorkDeadline(0, undefined)).toBe(0);
    expect(boundByWorkDeadline(0, performance.now() + 5_000)).toBeGreaterThan(4_900);
    expect(boundByWorkDeadline(30_000, performance.now() + 5_000)).toBeLessThanOrEqual(5_000);
    expect(boundByWorkDeadline(1_000, performance.now() + 5_000)).toBe(1_000);
  });

  it('reports a read as stopped only when its caller left or its limit passed', () => {
    const failure = new Error('store failed');
    expect(workStoppedError('blazegraph', failure, {})).toBe(failure);
    expect(workStoppedError('blazegraph', failure, { workDeadline: performance.now() + 60_000 })).toBe(failure);

    const passed = workStoppedError('blazegraph', failure, { workDeadline: performance.now() - 1 });
    expect(passed).toMatchObject({ code: 'QUERY_WORK_STOPPED', outcome: 'stopped', cause: failure });

    const controller = new AbortController();
    const reason = new Error('caller left');
    controller.abort(reason);
    expect(workStoppedError('oxigraph-server', failure, { signal: controller.signal }, 'not_started'))
      .toMatchObject({ code: 'QUERY_WORK_STOPPED', backend: 'oxigraph-server', outcome: 'not_started', cause: reason });
  });
});

describe('OxigraphStore persist barrier', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oxigraph-barrier-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const quad = (subject: string) => ({ subject, predicate: 'urn:p', object: 'urn:o', graph: 'urn:g' });

  it('puts a write on disk before it resolves', async () => {
    const path = join(dir, 'store.nq');
    const store = new OxigraphStore(path);
    await store.insert([quad('urn:barrier')]);
    await store.persistBarrier();
    // A cold reopen sees it, with no close() in between.
    const reopened = new OxigraphStore(path);
    expect(await reopened.query('ASK { GRAPH <urn:g> { <urn:barrier> <urn:p> <urn:o> } }'))
      .toEqual({ type: 'boolean', value: true });
    await reopened.close();
    await store.close();
  });

  it('writes nothing when nothing is pending', async () => {
    const path = join(dir, 'store.nq');
    const store = new OxigraphStore(path);
    await store.persistBarrier();
    expect(existsSync(path)).toBe(false);

    await store.insert([quad('urn:first')]);
    await store.persistBarrier();
    rmSync(path);
    // Clean again: a second barrier must not dump the store.
    await store.persistBarrier();
    expect(existsSync(path)).toBe(false);
    await store.insert([quad('urn:second')]);
    await store.persistBarrier();
    expect(existsSync(path)).toBe(true);
    await store.close();
  });

  it('never writes for an in-memory or read-only store', async () => {
    const memory = new OxigraphStore();
    await memory.insert([quad('urn:memory')]);
    await expect(memory.persistBarrier()).resolves.toBeUndefined();

    const path = join(dir, 'store.nq');
    const writable = new OxigraphStore(path);
    await writable.insert([quad('urn:owned')]);
    await writable.close();
    const readOnly = new OxigraphStore(path, { readOnly: true });
    rmSync(path);
    await readOnly.persistBarrier();
    expect(existsSync(path)).toBe(false);
  });
});

describe('Blazegraph stop helpers', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('adds no hint to text it cannot place one in', () => {
    expect(withBlazegraphQueryId('SELECT ?s WHERE { ?s ?p "unterminated }')).toBeNull();
    expect(withBlazegraphQueryId('SELECT ?s WHERE { ?s ?p ?o')).toBeNull();
    expect(withBlazegraphQueryId('SELECT ?s WHERE { ?s ?p \\u00ZZ }')).toBeNull();
    expect(withBlazegraphQueryId('SELECT ?s WHERE { ?s ?p ?o }')?.queryId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports a cancel that could not be delivered', async () => {
    globalThis.fetch = (async () => { throw new Error('connection refused'); }) as typeof fetch;
    await expect(cancelBlazegraphQuery('http://blazegraph.test/sparql', 'id')).resolves.toBe(false);
    globalThis.fetch = (async () => new Response('busy', { status: 503 })) as typeof fetch;
    await expect(cancelBlazegraphQuery('http://blazegraph.test/sparql', 'id')).resolves.toBe(false);
    globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
    await expect(cancelBlazegraphQuery('http://blazegraph.test/sparql', 'id')).resolves.toBe(true);
  });
});
