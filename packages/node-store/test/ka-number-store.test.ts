import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteKaNumberStore } from '../src/index.js';
import { DashboardDB } from './helpers/dashboard-db.js';

describe('SqliteKaNumberStore — bigint counter (codex PR #976 F6)', () => {
  let db: DashboardDB;
  let dir: string;
  let store: SqliteKaNumberStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-ka-number-store-test-'));
    db = new DashboardDB({ dataDir: dir });
    store = new SqliteKaNumberStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const AUTHOR = '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1';

  it('allocate / peekNext return bigint, not number', () => {
    const a = store.allocate(AUTHOR);
    expect(typeof a).toBe('bigint');
    expect(a).toBe(0n);

    expect(typeof store.peekNext(AUTHOR)).toBe('bigint');
    expect(store.peekNext(AUTHOR)).toBe(1n);

    expect(store.allocate(AUTHOR)).toBe(1n);
    expect(store.allocate(AUTHOR)).toBe(2n);
  });

  it('reconcileFloor accepts bigint and raises but never lowers', () => {
    store.reconcileFloor(AUTHOR, 41n);
    expect(store.peekNext(AUTHOR)).toBe(41n);
    expect(store.allocate(AUTHOR)).toBe(41n);

    // Stale floor must not pull the sequence backwards.
    store.reconcileFloor(AUTHOR, 5n);
    expect(store.peekNext(AUTHOR)).toBe(42n);
  });

  it('stays exact past Number.MAX_SAFE_INTEGER (no silent precision loss)', () => {
    // This is the F6 invariant against the REAL sqlite path. Pre-fix
    // the store returned JS `number`, so values past 2^53 would round
    // to the nearest even — successive `allocate()` calls could either
    // return the same value twice (kaId collision) or skip one.
    const past = BigInt(Number.MAX_SAFE_INTEGER); // 2^53 - 1
    store.reconcileFloor(AUTHOR, past);
    const a = store.allocate(AUTHOR);
    const b = store.allocate(AUTHOR);
    const c = store.allocate(AUTHOR);
    expect(a).toBe(past);
    expect(b).toBe(past + 1n);
    expect(c).toBe(past + 2n);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    // peekNext is also exact.
    expect(store.peekNext(AUTHOR)).toBe(past + 3n);
  });
});
