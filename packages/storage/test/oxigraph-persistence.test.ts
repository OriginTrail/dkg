/**
 * Regression tests for the durability contract documented in
 * packages/storage/README.md#oxigraph-persistence-contract.
 *
 * These cases exist because the original failure was a silent one — the
 * daemon happily reported a clean shutdown while torn writes / parse
 * failures / close-after-debounced-flush races nuked WM data. They are
 * the automated counterpart of the manual repro at
 * scripts/repro/wm-persistence-regression.mjs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import type { Quad } from '../src/triple-store.js';

const flushBarrier = vi.hoisted(() => ({
  tmpPath: null as string | null,
  onSnapshotCaptured: null as (() => void) | null,
  releaseSnapshot: null as Promise<void> | null,
  onSnapshotCommitted: null as (() => void) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: unknown[]) => {
      if (flushBarrier.tmpPath && String(args[0]) === flushBarrier.tmpPath && args[1] === 'w') {
        flushBarrier.onSnapshotCaptured?.();
        if (flushBarrier.releaseSnapshot) await flushBarrier.releaseSnapshot;
      }
      return Reflect.apply(actual.open, undefined, args);
    },
    rename: async (...args: unknown[]) => {
      await Reflect.apply(actual.rename, undefined, args);
      if (flushBarrier.tmpPath && String(args[0]) === flushBarrier.tmpPath) {
        flushBarrier.tmpPath = null;
        flushBarrier.onSnapshotCommitted?.();
      }
    },
  };
});

const SAMPLE: Quad[] = [
  {
    subject: 'http://ex.org/alice',
    predicate: 'http://schema.org/name',
    object: '"Alice"',
    graph: 'http://ex.org/g1',
  },
  {
    subject: 'http://ex.org/bob',
    predicate: 'http://schema.org/name',
    object: '"Bob"',
    graph: 'http://ex.org/g1',
  },
];

describe('OxigraphStore persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oxigraph-persist-'));
  });

  afterEach(() => {
    flushBarrier.tmpPath = null;
    flushBarrier.onSnapshotCaptured = null;
    flushBarrier.releaseSnapshot = null;
    flushBarrier.onSnapshotCommitted = null;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('close() persists data; a fresh instance hydrates it back', async () => {
    const path = join(dir, 'store.nq');

    const first = new OxigraphStore(path);
    await first.insert(SAMPLE);
    await first.close();

    // The on-disk file must exist and be non-empty.
    expect(existsSync(path)).toBe(true);

    // A fresh instance pointed at the same file should see all data.
    const second = new OxigraphStore(path);
    expect(await second.countQuads()).toBe(SAMPLE.length);
    const r = await second.query(
      'SELECT ?name WHERE { GRAPH <http://ex.org/g1> { <http://ex.org/alice> <http://schema.org/name> ?name } }',
    );
    expect(r.type).toBe('bindings');
    if (r.type === 'bindings') {
      expect(r.bindings.length).toBe(1);
      expect(r.bindings[0]?.name).toMatch(/Alice/);
    }
    await second.close();
  });

  it('a corrupt persist file is quarantined and constructor throws loudly', () => {
    const path = join(dir, 'store.nq');
    // Write deliberately invalid N-Quads — Oxigraph's parser will reject.
    writeFileSync(path, 'this is not valid n-quads ???\n', 'utf-8');

    // Construction must throw, not silently start with an empty store.
    expect(() => new OxigraphStore(path)).toThrow(/corrupt at/i);

    // The corrupt file must be renamed aside (so the next start succeeds
    // with a clean empty store) AND preserved for forensics.
    const entries = readdirSync(dir);
    const original = entries.find((e) => e === 'store.nq');
    const quarantined = entries.find((e) => e.startsWith('store.nq.corrupt-'));
    expect(original).toBeUndefined();
    expect(quarantined).toBeDefined();
  });

  it('flush() propagates write failures instead of silently swallowing them', async () => {
    // Point the store at a path inside a directory whose name is also a
    // regular file — both `mkdir` and `open(write)` against this path
    // will fail with ENOTDIR / EEXIST. We don't rely on a specific errno;
    // the contract is "the promise rejects, doesn't resolve clean".
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'i am a regular file, not a directory', 'utf-8');
    const path = join(blocker, 'store.nq');

    const store = new OxigraphStore(path);
    await store.insert(SAMPLE);

    // The 50ms debounced flush catches + logs; the explicit `flush()`
    // call must propagate the error so callers know data didn't land.
    await expect(store.flush()).rejects.toThrow();
    // Same contract for close() — explicit final flush propagates.
    await expect(store.close()).rejects.toThrow();
  });

  it('close() flushes writes added after an in-flight snapshot was captured', async () => {
    const path = join(dir, 'store.nq');
    const tmpPath = `${path}.tmp`;

    let markSnapshotCaptured!: () => void;
    const snapshotCaptured = new Promise<void>((resolve) => {
      markSnapshotCaptured = resolve;
    });
    let releaseSnapshot!: () => void;
    const snapshotRelease = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let markSnapshotCommitted!: () => void;
    const snapshotCommitted = new Promise<void>((resolve) => {
      markSnapshotCommitted = resolve;
    });

    flushBarrier.tmpPath = tmpPath;
    flushBarrier.onSnapshotCaptured = markSnapshotCaptured;
    flushBarrier.releaseSnapshot = snapshotRelease;
    flushBarrier.onSnapshotCommitted = markSnapshotCommitted;

    const first = new OxigraphStore(path);
    await first.insert(SAMPLE);

    // The mocked tmp-file open occurs after flushNow() captures the first
    // N-Quads snapshot. Hold it there, then add a sentinel that cannot be in
    // that snapshot and start close() while the background flush is in flight.
    await snapshotCaptured;
    const sentinel: Quad = {
      subject: 'http://ex.org/after-snapshot',
      predicate: 'http://ex.org/p',
      object: '"must-survive-close"',
      graph: 'http://ex.org/g1',
    };
    await first.insert([sentinel]);
    const closePromise = first.close();

    releaseSnapshot();
    await snapshotCommitted;
    await closePromise;

    const second = new OxigraphStore(path);
    expect(await second.countQuads()).toBe(SAMPLE.length + 1);
    const result = await second.query(
      'ASK { GRAPH <http://ex.org/g1> { <http://ex.org/after-snapshot> <http://ex.org/p> "must-survive-close" } }',
    );
    expect(result).toEqual({ type: 'boolean', value: true });
    await second.close();
  });

  it('mkdir-style errors during flush surface through close()', async () => {
    // Pointing persistPath at a sibling of an existing FILE (so the
    // ancestor `mkdir(dir, {recursive: true})` will work) is hard to
    // construct portably; instead use a path under a NON-EXISTENT
    // parent that's blocked by a file at one level up. That guarantees
    // mkdir errors. (We just covered this case above; here we just
    // assert close() rejects too.)
    const blocker = join(dir, 'blocker2');
    writeFileSync(blocker, 'blocker', 'utf-8');
    const path = join(blocker, 'nested', 'store.nq');

    const store = new OxigraphStore(path);
    await store.insert(SAMPLE);
    await expect(store.close()).rejects.toThrow();

    // Important: the in-memory data is still queryable — we only lose
    // durability, not the working set. (Useful for the operator to
    // dump-and-recover via another route after seeing the error.)
    const r = await store.query(
      'SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }',
    );
    expect(r.type).toBe('bindings');
  });
});
