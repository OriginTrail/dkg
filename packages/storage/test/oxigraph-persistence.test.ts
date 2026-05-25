/**
 * Regression tests for the durability contract documented in
 * docs/bugs/wm-persistence-regression.md.
 *
 * These cases exist because the original failure was a silent one — the
 * daemon happily reported a clean shutdown while torn writes / parse
 * failures / close-after-debounced-flush races nuked WM data. They are
 * the automated counterpart of the manual repro at
 * scripts/repro/wm-persistence-regression.mjs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import type { Quad } from '../src/triple-store.js';

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

  it('multiple inserts followed by close() all survive — no debounce-race loss', async () => {
    // This is the secondary regression: after the atomic-write fix,
    // close() short-circuited if a debounced flush was already in
    // flight, so the last batch of inserts could be silently dropped.
    // The fix is to await `flushing` before close()'s own flushNow().
    const path = join(dir, 'store.nq');

    const first = new OxigraphStore(path);
    // Fire many small inserts in rapid succession so the debounced
    // flush is likely in flight when we call close().
    for (let i = 0; i < 100; i++) {
      await first.insert([
        {
          subject: `http://ex.org/n${i}`,
          predicate: 'http://ex.org/p',
          object: `"v${i}"`,
          graph: 'http://ex.org/g1',
        },
      ]);
    }
    await first.close();

    const second = new OxigraphStore(path);
    expect(await second.countQuads()).toBe(100);
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
