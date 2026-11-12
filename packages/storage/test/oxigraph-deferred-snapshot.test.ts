// An update with `snapshot: 'deferred'` on the file-backed embedded store: it schedules no whole-store
// snapshot of its own, and the next snapshot, from another change, flush() or close(), holds it.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { OxigraphWorkerStore } from '../src/adapters/oxigraph-worker.js';
import type { TripleStore } from '../src/triple-store.js';

// The file system as the store's snapshots use it, each call passed through, so a test can hold one back or wait for it.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const GRAPH = 'urn:deferred-snapshot:graph';
const insert = (name: string) => `INSERT DATA { GRAPH <${GRAPH}> { <urn:s> <urn:p> <urn:${name}> } }`;
/** Whether the store's file holds the triple named `name`. */
const fileHolds = async (path: string, name: string) => existsSync(path) && (await readFile(path, 'utf8')).includes(`<urn:${name}>`);
/** Well past the 50 ms debounce of a scheduled snapshot. */
const pastDebounce = () => new Promise((resolve) => setTimeout(resolve, 400));

describe('a snapshot that falls due while another is being written', () => {
  const DEBOUNCE_MS = 50;
  let dir: string;
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it('is written once that one ends, with no flush or close', async () => {
    dir = await mkdtemp(join(tmpdir(), 'snapshot-in-flight-'));
    const path = join(dir, 'store.nq');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = new OxigraphStore(path, { flushDelayMs: DEBOUNCE_MS });
    // The first snapshot stops at its write, after it has read the store, until the test lets it go on.
    let reachWrite!: () => void;
    const atWrite = new Promise<void>((resolve) => { reachWrite = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof actualFs.open>) => {
      reachWrite();
      await released;
      return actualFs.open(...args);
    });
    try {
      await store.update(insert('first'));
      const begun = vi.mocked(mkdir).mock.calls.length;
      const first = store.flush();
      await atWrite;
      // The late update's snapshot falls due while the first one is held at its write.
      await store.update(insert('late'));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      release();
      await first;
      expect(await fileHolds(path, 'first')).toBe(true);
      expect(await fileHolds(path, 'late'), 'the snapshot that was being written').toBe(false);

      // A debounce later, the late update's own snapshot begins, and its file holds the update.
      let renamed!: () => void;
      const written = new Promise<void>((resolve) => { renamed = resolve; });
      vi.mocked(rename).mockImplementationOnce(async (...args: Parameters<typeof actualFs.rename>) => {
        await actualFs.rename(...args);
        renamed();
      });
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(vi.mocked(mkdir).mock.calls.length - begun, 'snapshots begun since the first update').toBe(2);
      await written;
      expect(await fileHolds(path, 'late'), 'the file after the late update\'s own snapshot').toBe(true);
    } finally {
      release();
      vi.useRealTimers();
      await store.close();
    }
  }, 30_000);
});

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
