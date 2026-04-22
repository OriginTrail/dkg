/**
 * publisher / WAL recovery — PR #229 bot review round 8
 * ------------------------------------------------------------------
 * Round 6 added a synchronous fsync'd write-ahead-log entry BEFORE
 * every on-chain broadcast so the publish intent would survive a
 * crash between `signTx` and `eth_sendRawTransaction`. Round 8 bot
 * review flagged that the round-6 fix was only half of P-1: the WAL
 * was fsync'd on write, but nothing ever reloaded it on startup, so
 * the in-memory `preBroadcastJournal` was still empty after a
 * process restart and the recovery path had nothing to reconcile.
 *
 * This file pins the full contract:
 *
 *   1. `readWalEntriesSync` tolerates missing / empty / partially
 *      written files and rejects malformed or incomplete records.
 *   2. `DKGPublisher` constructor seeds `preBroadcastJournal` from
 *      the configured WAL so surviving entries are visible to the
 *      recovery path without any manual bootstrap.
 *   3. `findWalEntryByMerkleRoot` locates a surviving entry given
 *      the `KnowledgeBatchCreated.merkleRoot` hex — the lookup key
 *      the chain poller actually owns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { EventBus } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  readWalEntriesSync,
  type PreBroadcastJournalEntry,
} from '../src/dkg-publisher.js';

function makeEntry(overrides: Partial<PreBroadcastJournalEntry> = {}): PreBroadcastJournalEntry {
  return {
    publishOperationId: 'op-xyz-1',
    contextGraphId: 'cg:test',
    v10ContextGraphId: '1',
    identityId: '42',
    publisherAddress: '0x1234567890abcdef1234567890abcdef12345678',
    merkleRoot: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    publishDigest: '0xabc1230000000000000000000000000000000000000000000000000000000000',
    ackCount: 1,
    kaCount: 1,
    publicByteSize: '128',
    tokenAmount: '0',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makePublisher(publishWalFilePath: string | undefined) {
  // Minimal shim-adapter set: the WAL recovery path runs entirely in
  // the constructor and doesn't call into chain / store / event bus.
  const store = {} as unknown as TripleStore;
  const eventBus = new EventEmitter() as unknown as EventBus;
  const chain = { chainId: 'none' } as unknown as ChainAdapter;
  const keypair = {
    publicKey: new Uint8Array(32),
    privateKey: new Uint8Array(64),
  };
  return new DKGPublisher({
    store,
    chain,
    eventBus,
    keypair,
    publishWalFilePath,
  });
}

let walDir: string;
let walPath: string;

beforeEach(async () => {
  walDir = await mkdtemp(join(tmpdir(), 'dkg-wal-recovery-'));
  walPath = join(walDir, 'publish.wal.ndjson');
});
afterEach(async () => {
  await rm(walDir, { recursive: true, force: true });
});

describe('readWalEntriesSync', () => {
  it('returns [] when the WAL file does not exist yet (no WAL configured ⇒ no recovery)', () => {
    expect(readWalEntriesSync(walPath)).toEqual([]);
  });

  it('returns [] on an empty WAL (file touched but nothing broadcast yet)', async () => {
    await writeFile(walPath, '', 'utf-8');
    expect(readWalEntriesSync(walPath)).toEqual([]);
  });

  it('round-trips multiple NDJSON entries in append order', async () => {
    const a = makeEntry({ publishOperationId: 'op-a', createdAt: 1 });
    const b = makeEntry({
      publishOperationId: 'op-b',
      createdAt: 2,
      merkleRoot: '0x' + 'bb'.repeat(32),
    });
    await writeFile(
      walPath,
      JSON.stringify(a) + '\n' + JSON.stringify(b) + '\n',
      'utf-8',
    );
    const loaded = readWalEntriesSync(walPath);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].publishOperationId).toBe('op-a');
    expect(loaded[1].publishOperationId).toBe('op-b');
  });

  it('skips a torn/partial final line (crash between `writeSync` and `fsyncSync` or inside the string)', async () => {
    const good = makeEntry({ publishOperationId: 'op-good' });
    // Final line is an unterminated JSON fragment — exactly the shape
    // produced by a crash partway through a WAL append.
    const torn = `{"publishOperationId":"op-torn","contextGraphId":"cg:`;
    await writeFile(walPath, JSON.stringify(good) + '\n' + torn, 'utf-8');
    const loaded = readWalEntriesSync(walPath);
    expect(loaded.map(e => e.publishOperationId)).toEqual(['op-good']);
  });

  it('skips records missing required fields so a schema drift cannot poison every later entry', async () => {
    const incomplete = { publishOperationId: 'op-missing-fields' };
    const good = makeEntry({ publishOperationId: 'op-good' });
    await writeFile(
      walPath,
      JSON.stringify(incomplete) + '\n' + JSON.stringify(good) + '\n',
      'utf-8',
    );
    const loaded = readWalEntriesSync(walPath);
    expect(loaded.map(e => e.publishOperationId)).toEqual(['op-good']);
  });

  it('tolerates blank lines between entries (e.g. a manual operator insert)', async () => {
    const a = makeEntry({ publishOperationId: 'op-a' });
    const b = makeEntry({ publishOperationId: 'op-b' });
    await writeFile(
      walPath,
      JSON.stringify(a) + '\n\n\n' + JSON.stringify(b) + '\n',
      'utf-8',
    );
    expect(readWalEntriesSync(walPath).map(e => e.publishOperationId)).toEqual(['op-a', 'op-b']);
  });
});

describe('DKGPublisher WAL recovery on construction', () => {
  it('seeds preBroadcastJournal from the WAL file (the round-8 gap)', async () => {
    const a = makeEntry({ publishOperationId: 'op-a' });
    const b = makeEntry({
      publishOperationId: 'op-b',
      merkleRoot: '0x' + 'bb'.repeat(32),
    });
    await writeFile(
      walPath,
      JSON.stringify(a) + '\n' + JSON.stringify(b) + '\n',
      'utf-8',
    );

    const publisher = makePublisher(walPath);
    expect(publisher.preBroadcastJournal.map(e => e.publishOperationId)).toEqual([
      'op-a',
      'op-b',
    ]);
  });

  it('starts with an empty journal when no WAL path is configured (single-process / test harness)', () => {
    const publisher = makePublisher(undefined);
    expect(publisher.preBroadcastJournal).toEqual([]);
  });

  it('starts with an empty journal when the WAL file has not been created yet', () => {
    const publisher = makePublisher(walPath);
    expect(publisher.preBroadcastJournal).toEqual([]);
  });

  it('caps the recovered journal at the 1024-entry high-water mark (same tail-retain as live path)', async () => {
    // Build 1200 entries and write them as NDJSON in one go. The
    // publisher must keep the last 1024 (newest-wins tail-retain).
    const lines: string[] = [];
    for (let i = 0; i < 1200; i++) {
      lines.push(JSON.stringify(makeEntry({ publishOperationId: `op-${i}` })));
    }
    await writeFile(walPath, lines.join('\n') + '\n', 'utf-8');
    const publisher = makePublisher(walPath);
    expect(publisher.preBroadcastJournal).toHaveLength(1024);
    // Newest retained is op-1199 (1200 − 1); oldest retained is
    // op-176 (1200 − 1024). Both invariants fail if the slice grabs
    // the head instead of the tail.
    expect(publisher.preBroadcastJournal[0].publishOperationId).toBe('op-176');
    expect(
      publisher.preBroadcastJournal[publisher.preBroadcastJournal.length - 1].publishOperationId,
    ).toBe('op-1199');
  });

  it('does NOT throw when the WAL file is corrupt — startup degrades to empty journal', async () => {
    await writeFile(walPath, '\x00\x01\x02not-json-at-all\n', 'utf-8');
    expect(() => makePublisher(walPath)).not.toThrow();
  });
});

describe('DKGPublisher.findWalEntryByMerkleRoot', () => {
  it('finds a surviving entry by the merkle root the chain poller emits (case-insensitive)', async () => {
    const target = makeEntry({
      publishOperationId: 'op-target',
      merkleRoot: '0x' + 'Ab'.repeat(32),
    });
    const other = makeEntry({
      publishOperationId: 'op-other',
      merkleRoot: '0x' + 'cd'.repeat(32),
    });
    await writeFile(
      walPath,
      JSON.stringify(other) + '\n' + JSON.stringify(target) + '\n',
      'utf-8',
    );
    const publisher = makePublisher(walPath);
    const match = publisher.findWalEntryByMerkleRoot('0x' + 'AB'.repeat(32));
    expect(match?.publishOperationId).toBe('op-target');
  });

  it('returns the most-recent entry when two entries share a merkle root (retry replay)', async () => {
    const first = makeEntry({ publishOperationId: 'op-first', createdAt: 1 });
    const retry = makeEntry({ publishOperationId: 'op-retry', createdAt: 2 });
    await appendFile(walPath, JSON.stringify(first) + '\n', 'utf-8');
    await appendFile(walPath, JSON.stringify(retry) + '\n', 'utf-8');
    const publisher = makePublisher(walPath);
    const match = publisher.findWalEntryByMerkleRoot(first.merkleRoot);
    expect(match?.publishOperationId).toBe('op-retry');
  });

  it('returns undefined when no surviving entry matches', () => {
    const publisher = makePublisher(walPath);
    expect(publisher.findWalEntryByMerkleRoot('0x' + 'ff'.repeat(32))).toBeUndefined();
  });
});
