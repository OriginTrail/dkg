// An update with `snapshot: 'deferred'` on the file-backed embedded store: it schedules no whole-store
// snapshot of its own, and the next snapshot, from another change, flush() or close(), holds it.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { OxigraphWorkerStore } from '../src/adapters/oxigraph-worker.js';
import type { TripleStore } from '../src/triple-store.js';

const GRAPH = 'urn:deferred-snapshot:graph';
const insert = (name: string) => `INSERT DATA { GRAPH <${GRAPH}> { <urn:s> <urn:p> <urn:${name}> } }`;
/** Whether the store's file holds the triple named `name`. */
const fileHolds = async (path: string, name: string) => existsSync(path) && (await readFile(path, 'utf8')).includes(`<urn:${name}>`);
/** Well past the 50 ms debounce of a scheduled snapshot. */
const pastDebounce = () => new Promise((resolve) => setTimeout(resolve, 400));

describe.each([
  ['in process', (path: string): TripleStore => new OxigraphStore(path)],
  ['in its worker', (path: string): TripleStore => new OxigraphWorkerStore(path)],
] as const)('a deferred update on the file-backed embedded store, %s', (_where, open) => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deferred-snapshot-'));
    path = join(dir, 'store.nq');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('writes no snapshot of its own, and the next change\'s snapshot holds it', async () => {
    const store = open(path);
    try {
      await store.update!(insert('before'));
      await vi.waitFor(async () => expect(await fileHolds(path, 'before')).toBe(true), { timeout: 10_000 });

      await store.update!(insert('deferred'), { snapshot: 'deferred' });
      await pastDebounce();
      expect(await fileHolds(path, 'deferred'), 'the file after the deferred update').toBe(false);

      await store.update!(insert('after'));
      await vi.waitFor(async () => expect(await fileHolds(path, 'after')).toBe(true), { timeout: 10_000 });
      expect(await fileHolds(path, 'deferred'), 'the snapshot of the next change').toBe(true);
    } finally { await store.close(); }
  }, 30_000);

  it('is written by flush() and by close()', async () => {
    const store = open(path);
    let closed = false;
    try {
      await store.update!(insert('flushed'), { snapshot: 'deferred' });
      await store.flush!();
      expect(await fileHolds(path, 'flushed')).toBe(true);

      await store.update!(insert('closed'), { snapshot: 'deferred' });
      await store.close();
      closed = true;
      expect(await fileHolds(path, 'closed')).toBe(true);
    } finally { if (!closed) await store.close(); }
  }, 30_000);
});
