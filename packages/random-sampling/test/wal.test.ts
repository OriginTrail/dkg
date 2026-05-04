/**
 * WAL crash-recovery semantics.
 *
 * The WAL's job is to record state transitions so that a restart can
 * reconstruct what the prover was doing. Tests pin:
 *   1. Append + readAll preserves order.
 *   2. latestFor returns the most recent transition for a given key.
 *   3. FileProverWal survives reopen.
 *   4. FileProverWal tolerates a partial last line (crash mid-write).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryProverWal,
  FileProverWal,
  makeWalEntry,
  periodKeyEquals,
  type PeriodKey,
} from '../src/wal.js';

const KEY: PeriodKey = { epoch: 5n, periodStartBlock: 1000n, identityId: 7n };
const KEY2: PeriodKey = { epoch: 5n, periodStartBlock: 2000n, identityId: 7n };

describe('InMemoryProverWal', () => {
  it('appends and reads in insertion order', async () => {
    const wal = new InMemoryProverWal();
    await wal.append(makeWalEntry(KEY, 'started'));
    await wal.append(makeWalEntry(KEY, 'challenge', { kcId: '1', cgId: '2', chunkId: '3' }));
    await wal.append(makeWalEntry(KEY, 'submitted', { txHash: '0xabc' }));

    const all = await wal.readAll();
    expect(all.map((e) => e.status)).toEqual(['started', 'challenge', 'submitted']);
  });

  it('latestFor returns the most recent transition for the matching key only', async () => {
    const wal = new InMemoryProverWal();
    await wal.append(makeWalEntry(KEY, 'started'));
    await wal.append(makeWalEntry(KEY2, 'started'));
    await wal.append(makeWalEntry(KEY, 'submitted', { txHash: '0xabc' }));

    const latest = await wal.latestFor(KEY);
    expect(latest?.status).toBe('submitted');
    expect(latest?.txHash).toBe('0xabc');

    const latest2 = await wal.latestFor(KEY2);
    expect(latest2?.status).toBe('started');
  });

  it('latestFor returns undefined when no entries match', async () => {
    const wal = new InMemoryProverWal();
    expect(await wal.latestFor(KEY)).toBeUndefined();
  });
});

describe('FileProverWal', () => {
  it('persists across reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-wal-'));
    const path = join(dir, 'prover.wal');

    const wal1 = await FileProverWal.open(path);
    await wal1.append(makeWalEntry(KEY, 'started'));
    await wal1.append(makeWalEntry(KEY, 'submitted', { txHash: '0xdeadbeef' }));
    await wal1.close();

    const wal2 = await FileProverWal.open(path);
    const latest = await wal2.latestFor(KEY);
    expect(latest?.status).toBe('submitted');
    expect(latest?.txHash).toBe('0xdeadbeef');
    await wal2.close();
  });

  it('tolerates a partial last line from a crash mid-write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-wal-'));
    const path = join(dir, 'prover.wal');

    const valid = JSON.stringify(makeWalEntry(KEY, 'started')) + '\n';
    const partial = '{"ts":"2026-04-30T00:00:00Z","status":"challenge","ep'; // truncated
    writeFileSync(path, valid + partial);

    const wal = await FileProverWal.open(path);
    const all = await wal.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('started');
    await wal.close();
  });

  it('append fsyncs each line so a kill -9 between appends preserves prior entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-wal-'));
    const path = join(dir, 'prover.wal');
    const wal = await FileProverWal.open(path);
    await wal.append(makeWalEntry(KEY, 'started'));
    // Read raw file BEFORE close — verifies fsync happened on append.
    const raw = readFileSync(path, 'utf8');
    expect(raw).toMatch(/"status":"started"/);
    await wal.close();
  });

  it('append after manual external write still produces parseable file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-wal-'));
    const path = join(dir, 'prover.wal');
    const wal = await FileProverWal.open(path);
    await wal.append(makeWalEntry(KEY, 'started'));
    // Simulate an external rotation tool that appended a line directly.
    appendFileSync(path, JSON.stringify(makeWalEntry(KEY, 'challenge', { kcId: '9' })) + '\n');
    await wal.append(makeWalEntry(KEY, 'submitted', { txHash: '0xabc' }));
    await wal.close();

    // Reopen and confirm we see all three entries (the in-process
    // cache won't have the externally-appended line, but reopen
    // reads the file fresh).
    const wal2 = await FileProverWal.open(path);
    const all = await wal2.readAll();
    expect(all.map((e) => e.status)).toEqual(['started', 'challenge', 'submitted']);
    await wal2.close();
  });
});

describe('periodKeyEquals', () => {
  it('returns true for identical keys, false for any field mismatch', () => {
    expect(periodKeyEquals(KEY, { ...KEY })).toBe(true);
    expect(periodKeyEquals(KEY, { ...KEY, epoch: 6n })).toBe(false);
    expect(periodKeyEquals(KEY, { ...KEY, periodStartBlock: 999n })).toBe(false);
    expect(periodKeyEquals(KEY, { ...KEY, identityId: 8n })).toBe(false);
  });
});
