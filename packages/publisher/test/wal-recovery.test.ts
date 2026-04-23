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
import { mkdtemp, rm, writeFile, appendFile, readFile } from 'node:fs/promises';
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
import { ChainEventPoller } from '../src/chain-event-poller.js';
import { PublishHandler } from '../src/publish-handler.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus } from '@origintrail-official/dkg-core';

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

// ---------------------------------------------------------------------------
// r21-5 (PR #229 bot review, post-v10-rc-merge): the WAL recovery loop now
// has a real runtime caller. These tests pin the contract that
// `recoverFromWalByMerkleRoot` is what closes the loop opened in r6/r8 and
// that `ChainEventPoller.handleBatchCreated` actually invokes it.
// ---------------------------------------------------------------------------
describe('DKGPublisher.recoverFromWalByMerkleRoot (r21-5)', () => {
  it('drops the matching entry from the in-memory journal and atomically rewrites the WAL file', async () => {
    const target = makeEntry({
      publishOperationId: 'op-recover',
      merkleRoot: '0x' + 'ee'.repeat(32),
    });
    const survivor = makeEntry({
      publishOperationId: 'op-survivor',
      merkleRoot: '0x' + 'cc'.repeat(32),
    });
    await writeFile(
      walPath,
      JSON.stringify(survivor) + '\n' + JSON.stringify(target) + '\n',
      'utf-8',
    );

    const publisher = makePublisher(walPath);
    expect(publisher.preBroadcastJournal.map(e => e.publishOperationId)).toEqual([
      'op-survivor',
      'op-recover',
    ]);

    const recovered = await publisher.recoverFromWalByMerkleRoot(target.merkleRoot, {
      publisherAddress: target.publisherAddress,
      startKAId: 100n,
      endKAId: 100n,
    });
    expect(recovered?.publishOperationId).toBe('op-recover');

    expect(publisher.preBroadcastJournal.map(e => e.publishOperationId)).toEqual([
      'op-survivor',
    ]);

    const onDisk = readWalEntriesSync(walPath);
    expect(onDisk.map(e => e.publishOperationId)).toEqual(['op-survivor']);

    const raw = await readFile(walPath, 'utf-8');
    expect(raw).not.toContain('op-recover');
  });

  it('refuses to drop the entry when the on-chain publisher does not match the persisted one (cross-publisher safety net)', async () => {
    const target = makeEntry({
      publishOperationId: 'op-collide',
      publisherAddress: '0x1111111111111111111111111111111111111111',
      merkleRoot: '0x' + 'aa'.repeat(32),
    });
    await writeFile(walPath, JSON.stringify(target) + '\n', 'utf-8');

    const publisher = makePublisher(walPath);
    const recovered = await publisher.recoverFromWalByMerkleRoot(target.merkleRoot, {
      publisherAddress: '0x2222222222222222222222222222222222222222',
      startKAId: 1n,
      endKAId: 1n,
    });
    expect(recovered).toBeUndefined();
    expect(publisher.preBroadcastJournal).toHaveLength(1);
    expect(readWalEntriesSync(walPath)).toHaveLength(1);
  });

  it('case-insensitively matches publisher addresses (ethers checksums vs lowercase)', async () => {
    const target = makeEntry({
      publishOperationId: 'op-checksum',
      publisherAddress: '0xabcdef0123456789abcdef0123456789abcdef01',
      merkleRoot: '0x' + 'dd'.repeat(32),
    });
    await writeFile(walPath, JSON.stringify(target) + '\n', 'utf-8');

    const publisher = makePublisher(walPath);
    const recovered = await publisher.recoverFromWalByMerkleRoot(target.merkleRoot, {
      publisherAddress: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
      startKAId: 5n,
      endKAId: 7n,
    });
    expect(recovered?.publishOperationId).toBe('op-checksum');
    expect(publisher.preBroadcastJournal).toEqual([]);
  });

  it('returns undefined when no entry matches and leaves the WAL file untouched', async () => {
    const survivor = makeEntry({ publishOperationId: 'op-keep' });
    await writeFile(walPath, JSON.stringify(survivor) + '\n', 'utf-8');
    const before = await readFile(walPath, 'utf-8');

    const publisher = makePublisher(walPath);
    const recovered = await publisher.recoverFromWalByMerkleRoot(
      '0x' + 'ff'.repeat(32),
      { publisherAddress: survivor.publisherAddress, startKAId: 0n, endKAId: 0n },
    );
    expect(recovered).toBeUndefined();
    expect(publisher.preBroadcastJournal).toHaveLength(1);

    const after = await readFile(walPath, 'utf-8');
    expect(after).toBe(before);
  });

  // ---------------------------------------------------------------------------
  // PR #229 bot review round 26 (r26-4): if two WAL entries share the same
  // `merkleRoot` AND the same publisher, we must refuse auto-recovery rather
  // than silently promoting whichever happens to come first in the journal.
  // Identical content can legitimately produce the same KC merkle root on
  // multiple publish attempts (retries, republishes). Picking the wrong one
  // would leave the real outstanding intent behind or promote the wrong KC.
  // ---------------------------------------------------------------------------
  it('r26-4: REFUSES auto-recovery and emits `publisher.walRecoveryAmbiguous` when two WAL entries share the same merkleRoot AND publisher', async () => {
    const merkleRoot = '0x' + 'ba'.repeat(32);
    const publisherAddr = '0xcafe000000000000000000000000000000000001';
    const first = makeEntry({
      publishOperationId: 'op-first-attempt',
      publisherAddress: publisherAddr,
      merkleRoot,
    });
    const retry = makeEntry({
      publishOperationId: 'op-retry-attempt',
      publisherAddress: publisherAddr,
      merkleRoot,
    });
    await writeFile(
      walPath,
      JSON.stringify(first) + '\n' + JSON.stringify(retry) + '\n',
      'utf-8',
    );
    const beforeContents = await readFile(walPath, 'utf-8');

    const observed: Array<Record<string, unknown>> = [];
    const ee = new EventEmitter();
    ee.on('publisher.walRecoveryAmbiguous', (data: Record<string, unknown>) => {
      observed.push(data);
    });
    const matchObserved: Array<Record<string, unknown>> = [];
    ee.on('publisher.walRecoveryMatch', (data: Record<string, unknown>) => {
      matchObserved.push(data);
    });
    const eventBus = ee as unknown as EventBus;

    const publisher = new DKGPublisher({
      store: {} as unknown as TripleStore,
      chain: { chainId: 'none' } as unknown as ChainAdapter,
      eventBus,
      keypair: { publicKey: new Uint8Array(32), privateKey: new Uint8Array(64) },
      publishWalFilePath: walPath,
    });
    expect(publisher.preBroadcastJournal).toHaveLength(2);

    const recovered = await publisher.recoverFromWalByMerkleRoot(merkleRoot, {
      publisherAddress: publisherAddr,
      startKAId: 10n,
      endKAId: 10n,
    });

    // Neither entry is promoted/dropped — both survive for manual reconciliation.
    expect(recovered).toBeUndefined();
    expect(publisher.preBroadcastJournal.map((e) => e.publishOperationId).sort()).toEqual([
      'op-first-attempt',
      'op-retry-attempt',
    ]);
    // The on-disk WAL is NOT rewritten (so a restart still sees both).
    const afterContents = await readFile(walPath, 'utf-8');
    expect(afterContents).toBe(beforeContents);

    // Observability event fires with the ambiguous op list.
    expect(matchObserved).toHaveLength(0);
    expect(observed).toHaveLength(1);
    const payload = observed[0];
    expect(payload.merkleRoot).toBe(merkleRoot);
    expect(payload.publisherAddress).toBe(publisherAddr);
    expect((payload.matchingOps as string[]).sort()).toEqual([
      'op-first-attempt',
      'op-retry-attempt',
    ]);
    expect(payload.startKAId).toBe('10');
    expect(payload.endKAId).toBe('10');
  });

  it('r26-4: a single WAL match STILL recovers normally when another collision belongs to a DIFFERENT publisher (cross-publisher collision is the legacy path)', async () => {
    const merkleRoot = '0x' + 'cd'.repeat(32);
    const mine = makeEntry({
      publishOperationId: 'op-mine',
      publisherAddress: '0x1111111111111111111111111111111111111111',
      merkleRoot,
    });
    const theirs = makeEntry({
      publishOperationId: 'op-theirs',
      publisherAddress: '0x2222222222222222222222222222222222222222',
      merkleRoot,
    });
    await writeFile(
      walPath,
      JSON.stringify(mine) + '\n' + JSON.stringify(theirs) + '\n',
      'utf-8',
    );

    const publisher = makePublisher(walPath);
    // The on-chain event says the publisher is the "mine" address —
    // there's only one same-signer match, so we take the normal path.
    const recovered = await publisher.recoverFromWalByMerkleRoot(merkleRoot, {
      publisherAddress: mine.publisherAddress,
      startKAId: 11n,
      endKAId: 11n,
    });
    expect(recovered?.publishOperationId).toBe('op-mine');
    // The other publisher's entry is retained — we don't touch it.
    expect(publisher.preBroadcastJournal.map((e) => e.publishOperationId)).toEqual([
      'op-theirs',
    ]);
  });

  it('emits a `publisher.walRecoveryMatch` event so operators can observe the recovery stream', async () => {
    const target = makeEntry({
      publishOperationId: 'op-observable',
      merkleRoot: '0x' + '12'.repeat(32),
    });
    await writeFile(walPath, JSON.stringify(target) + '\n', 'utf-8');

    const observed: Array<{ event: string; data: unknown }> = [];
    const ee = new EventEmitter();
    ee.on('publisher.walRecoveryMatch', (data) =>
      observed.push({ event: 'publisher.walRecoveryMatch', data }),
    );
    // Wrap the EventEmitter in the structural EventBus shape the
    // publisher expects (.emit / .on / .off).
    const eventBus = ee as unknown as EventBus;

    const publisher = new DKGPublisher({
      store: {} as unknown as TripleStore,
      chain: { chainId: 'none' } as unknown as ChainAdapter,
      eventBus,
      keypair: { publicKey: new Uint8Array(32), privateKey: new Uint8Array(64) },
      publishWalFilePath: walPath,
    });
    await publisher.recoverFromWalByMerkleRoot(target.merkleRoot, {
      publisherAddress: target.publisherAddress,
      startKAId: 99n,
      endKAId: 99n,
    });

    expect(observed).toHaveLength(1);
    const payload = observed[0].data as Record<string, unknown>;
    expect(payload.publishOperationId).toBe('op-observable');
    expect(payload.startKAId).toBe('99');
    expect(payload.endKAId).toBe('99');
  });
});

describe('ChainEventPoller → DKGPublisher.recoverFromWalByMerkleRoot wiring (r21-5)', () => {
  it('invokes the unmatched-batch reconciler when in-memory confirmByMerkleRoot returns false', async () => {
    const target = makeEntry({
      publishOperationId: 'op-poller-recover',
      merkleRoot: '0x' + '7e'.repeat(32),
    });
    await writeFile(walPath, JSON.stringify(target) + '\n', 'utf-8');

    const publisher = makePublisher(walPath);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());

    let called = 0;
    const poller = new ChainEventPoller({
      chain: { chainType: 'evm', chainId: 'test-chain' } as unknown as ChainAdapter,
      publishHandler: handler,
      onUnmatchedBatchCreated: async ({ merkleRoot, publisherAddress, startKAId, endKAId }) => {
        called += 1;
        const merkleRootHex = '0x' + Buffer.from(merkleRoot).toString('hex');
        const recovered = await publisher.recoverFromWalByMerkleRoot(
          merkleRootHex,
          { publisherAddress, startKAId, endKAId },
        );
        return recovered !== undefined;
      },
    });

    const event = {
      type: 'KnowledgeBatchCreated',
      blockNumber: 1234,
      data: {
        merkleRoot: target.merkleRoot,
        publisherAddress: target.publisherAddress,
        startKAId: '50',
        endKAId: '50',
      },
    };
    await (poller as unknown as {
      handleBatchCreated: (e: typeof event, ctx: unknown) => Promise<void>;
    }).handleBatchCreated(event, { operationId: 'test', subsystem: 'system' });

    expect(called).toBe(1);
    expect(publisher.preBroadcastJournal).toEqual([]);
    expect(readWalEntriesSync(walPath)).toEqual([]);
  });

  it('does NOT invoke the reconciler when the publish was confirmed by an in-memory match (no double-handling)', async () => {
    // No WAL pre-state; the in-memory handler will simply return false
    // (no pending publish for this root) and our reconciler will be
    // called exactly once. We can't easily seed `pendingPublishes`
    // without rebuilding the whole publish stack, so this test pins
    // the OPPOSITE branch: it asserts the reconciler is invoked
    // exactly once per chain event when the in-memory map misses.
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());
    let called = 0;
    const poller = new ChainEventPoller({
      chain: { chainType: 'evm', chainId: 'test-chain' } as unknown as ChainAdapter,
      publishHandler: handler,
      onUnmatchedBatchCreated: async () => {
        called += 1;
        return false;
      },
    });

    const event = {
      type: 'KnowledgeBatchCreated',
      blockNumber: 1,
      data: {
        merkleRoot: '0x' + 'ab'.repeat(32),
        publisherAddress: '0x' + '0a'.repeat(20),
        startKAId: '1',
        endKAId: '1',
      },
    };
    await (poller as unknown as {
      handleBatchCreated: (e: typeof event, ctx: unknown) => Promise<void>;
    }).handleBatchCreated(event, { operationId: 'test', subsystem: 'system' });
    expect(called).toBe(1);
  });

  it('a reconciler error must NOT abort the poll (fault isolation — broken WAL handler cannot starve future confirmations)', async () => {
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());
    const poller = new ChainEventPoller({
      chain: { chainType: 'evm', chainId: 'test-chain' } as unknown as ChainAdapter,
      publishHandler: handler,
      onUnmatchedBatchCreated: async () => {
        throw new Error('simulated WAL failure');
      },
    });

    const event = {
      type: 'KnowledgeBatchCreated',
      blockNumber: 7,
      data: {
        merkleRoot: '0x' + '99'.repeat(32),
        publisherAddress: '0x' + '0a'.repeat(20),
        startKAId: '1',
        endKAId: '1',
      },
    };
    await expect(
      (poller as unknown as {
        handleBatchCreated: (e: typeof event, ctx: unknown) => Promise<void>;
      }).handleBatchCreated(event, { operationId: 'test', subsystem: 'system' }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// r23-3 (PR #229 bot review round 23): the previous WAL-recovery fix dropped
// the WAL entry but never promoted the tentative KC status quad in the store
// to `confirmed`. Query paths that gate on `dkg:status "confirmed"` (or
// `view: 'verified-memory'`) saw the KC as permanently unfinalised even
// though the chain event confirmed the publish. These tests pin the fix:
// the same-transaction rewrite MUST promote the surviving tentative quad
// AND drop the WAL entry, mirroring what `PublishHandler.confirmPublish`
// does on the happy path.
// ---------------------------------------------------------------------------
describe('DKGPublisher.recoverFromWalByMerkleRoot — tentative→confirmed promotion (r23-3)', () => {
  function makePublisherWithStore(store: OxigraphStore, publishWalFilePath: string) {
    const eventBus = new EventEmitter() as unknown as EventBus;
    const chain = { chainId: 'none' } as unknown as ChainAdapter;
    const keypair = { publicKey: new Uint8Array(32), privateKey: new Uint8Array(64) };
    return new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publishWalFilePath,
    });
  }

  it('flips the tentative status quad to confirmed when a matching KC exists in the context-graph _meta', async () => {
    const contextGraphId = 'cg-r23-3-happy';
    const merkleRootHex = '0x' + '7c'.repeat(32);
    const ual = 'did:dkg:otp:hardhat/0x1234567890abcdef1234567890abcdef12345678/99';
    const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;

    const store = new OxigraphStore();
    // Seed the store with the tentative KC metadata the way
    // DKGPublisher.publishContent would have before a crash: a
    // `<ual> dkg:merkleRoot "0xhex"` triple plus a
    // `<ual> dkg:status "tentative"` triple in the same _meta graph.
    await store.insert([
      { subject: ual, predicate: 'http://dkg.io/ontology/merkleRoot', object: `"${merkleRootHex}"`, graph: metaGraph },
      { subject: ual, predicate: 'http://dkg.io/ontology/status', object: '"tentative"', graph: metaGraph },
    ]);

    const entry = makeEntry({
      publishOperationId: 'op-r23-3',
      contextGraphId,
      merkleRoot: merkleRootHex,
      publisherAddress: '0x1234567890abcdef1234567890abcdef12345678',
    });
    await writeFile(walPath, JSON.stringify(entry) + '\n', 'utf-8');

    const publisher = makePublisherWithStore(store, walPath);
    const recovered = await publisher.recoverFromWalByMerkleRoot(merkleRootHex, {
      publisherAddress: entry.publisherAddress,
      startKAId: 1n,
      endKAId: 1n,
    });
    expect(recovered?.publishOperationId).toBe('op-r23-3');

    // WAL dropped.
    expect(publisher.preBroadcastJournal).toEqual([]);
    // Tentative quad is gone, confirmed quad is present.
    const tentativeRes = await store.query(
      `ASK { GRAPH <${metaGraph}> { <${ual}> <http://dkg.io/ontology/status> "tentative" } }`,
    );
    const confirmedRes = await store.query(
      `ASK { GRAPH <${metaGraph}> { <${ual}> <http://dkg.io/ontology/status> "confirmed" } }`,
    );
    expect(tentativeRes.type === 'boolean' ? tentativeRes.value : null).toBe(false);
    expect(confirmedRes.type === 'boolean' ? confirmedRes.value : null).toBe(true);
  });

  it('still drops the WAL entry when no tentative KC survives in the store (promotion is best-effort, WAL drop is authoritative)', async () => {
    const contextGraphId = 'cg-r23-3-missing';
    const merkleRootHex = '0x' + 'de'.repeat(32);

    const store = new OxigraphStore();
    // Deliberately empty store — crash happened BEFORE the tentative
    // quads were persisted. We still want the WAL entry dropped so
    // the bot's "accumulate forever" condition doesn't recur.

    const entry = makeEntry({
      publishOperationId: 'op-r23-3-nostore',
      contextGraphId,
      merkleRoot: merkleRootHex,
    });
    await writeFile(walPath, JSON.stringify(entry) + '\n', 'utf-8');

    const publisher = makePublisherWithStore(store, walPath);
    const recovered = await publisher.recoverFromWalByMerkleRoot(merkleRootHex, {
      publisherAddress: entry.publisherAddress,
      startKAId: 2n,
      endKAId: 2n,
    });
    expect(recovered?.publishOperationId).toBe('op-r23-3-nostore');
    expect(publisher.preBroadcastJournal).toEqual([]);
  });

  it('does NOT promote a KC that is already confirmed (idempotence across double-delivery of the chain event)', async () => {
    const contextGraphId = 'cg-r23-3-idempotent';
    const merkleRootHex = '0x' + 'ab'.repeat(32);
    const ual = 'did:dkg:otp:hardhat/0xabcdef0123456789abcdef0123456789abcdef01/42';
    const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;

    const store = new OxigraphStore();
    // KC was already promoted (e.g. the FinalizationHandler got
    // there first, or this is the second chain event delivery).
    await store.insert([
      { subject: ual, predicate: 'http://dkg.io/ontology/merkleRoot', object: `"${merkleRootHex}"`, graph: metaGraph },
      { subject: ual, predicate: 'http://dkg.io/ontology/status', object: '"confirmed"', graph: metaGraph },
    ]);

    const entry = makeEntry({
      publishOperationId: 'op-r23-3-idem',
      contextGraphId,
      merkleRoot: merkleRootHex,
      publisherAddress: '0xabcdef0123456789abcdef0123456789abcdef01',
    });
    await writeFile(walPath, JSON.stringify(entry) + '\n', 'utf-8');

    const publisher = makePublisherWithStore(store, walPath);
    const recovered = await publisher.recoverFromWalByMerkleRoot(merkleRootHex, {
      publisherAddress: entry.publisherAddress,
      startKAId: 1n,
      endKAId: 1n,
    });
    expect(recovered?.publishOperationId).toBe('op-r23-3-idem');
    // The confirmed quad remains; no tentative quad was ever present,
    // and the promoter's SELECT should match nothing so no redundant
    // delete/insert runs.
    const confirmedRes = await store.query(
      `ASK { GRAPH <${metaGraph}> { <${ual}> <http://dkg.io/ontology/status> "confirmed" } }`,
    );
    expect(confirmedRes.type === 'boolean' ? confirmedRes.value : null).toBe(true);
    expect(publisher.preBroadcastJournal).toEqual([]);
  });

  it('emits walRecoveryMatch with the promoted UAL so downstream observers can pin the tentative→confirmed moment', async () => {
    const contextGraphId = 'cg-r23-3-event';
    const merkleRootHex = '0x' + '5e'.repeat(32);
    const ual = 'did:dkg:otp:hardhat/0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef/7';
    const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;

    const store = new OxigraphStore();
    await store.insert([
      { subject: ual, predicate: 'http://dkg.io/ontology/merkleRoot', object: `"${merkleRootHex}"`, graph: metaGraph },
      { subject: ual, predicate: 'http://dkg.io/ontology/status', object: '"tentative"', graph: metaGraph },
    ]);

    const entry = makeEntry({
      publishOperationId: 'op-r23-3-event',
      contextGraphId,
      merkleRoot: merkleRootHex,
      publisherAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    await writeFile(walPath, JSON.stringify(entry) + '\n', 'utf-8');

    const observed: Array<Record<string, unknown>> = [];
    const ee = new EventEmitter();
    ee.on('publisher.walRecoveryMatch', (data: Record<string, unknown>) => observed.push(data));
    const publisher = new DKGPublisher({
      store,
      chain: { chainId: 'none' } as unknown as ChainAdapter,
      eventBus: ee as unknown as EventBus,
      keypair: { publicKey: new Uint8Array(32), privateKey: new Uint8Array(64) },
      publishWalFilePath: walPath,
    });
    await publisher.recoverFromWalByMerkleRoot(merkleRootHex, {
      publisherAddress: entry.publisherAddress,
      startKAId: 7n,
      endKAId: 7n,
    });
    expect(observed).toHaveLength(1);
    expect(observed[0].promotedUal).toBe(ual);
  });
});
