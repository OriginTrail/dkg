import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PublishJournal, type JournalEntry } from '../src/publish-journal.js';

let dataDir: string;
let journal: PublishJournal;

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ual: 'did:dkg:mock:31337/0xABC/42',
    contextGraphId: 'test-paranet',
    expectedPublisherAddress: '0x1234567890abcdef1234567890abcdef12345678',
    expectedMerkleRoot: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    expectedStartKAId: '100',
    expectedEndKAId: '105',
    expectedChainId: 'mock:31337',
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'dkg-journal-test-'));
  journal = new PublishJournal(dataDir);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('PublishJournal', () => {
  it('save/load roundtrip preserves entries', async () => {
    const entries = [makeEntry(), makeEntry({ ual: 'did:dkg:mock:31337/0xABC/43' })];
    await journal.save(entries);
    const loaded = await journal.load();

    expect(loaded).toHaveLength(2);
    expect(loaded[0].ual).toBe(entries[0].ual);
    expect(loaded[1].ual).toBe(entries[1].ual);
    expect(loaded[0].expectedPublisherAddress).toBe(entries[0].expectedPublisherAddress);
    expect(loaded[0].expectedChainId).toBe(entries[0].expectedChainId);
    expect(loaded[0].createdAt).toBe(entries[0].createdAt);
  });

  it('load returns [] when no file exists', async () => {
    const loaded = await journal.load();
    expect(loaded).toEqual([]);
  });

  it('clear removes the file', async () => {
    await journal.save([makeEntry()]);
    let loaded = await journal.load();
    expect(loaded).toHaveLength(1);

    await journal.clear();
    loaded = await journal.load();
    expect(loaded).toEqual([]);
  });

  it('clear is idempotent (no error on missing file)', async () => {
    await expect(journal.clear()).resolves.toBeUndefined();
  });

  it('correctly serializes/deserializes bigint-like strings', async () => {
    const entry = makeEntry({
      expectedStartKAId: '999999999999999999999',
      expectedEndKAId: '1000000000000000000000',
    });
    await journal.save([entry]);
    const [loaded] = await journal.load();

    expect(BigInt(loaded.expectedStartKAId)).toBe(999999999999999999999n);
    expect(BigInt(loaded.expectedEndKAId)).toBe(1000000000000000000000n);
  });

  it('correctly serializes/deserializes hex merkle root (Uint8Array equivalent)', async () => {
    const merkleHex = '0x' + 'ab'.repeat(32);
    const entry = makeEntry({ expectedMerkleRoot: merkleHex });
    await journal.save([entry]);
    const [loaded] = await journal.load();

    expect(loaded.expectedMerkleRoot).toBe(merkleHex);

    const bytes = Buffer.from(loaded.expectedMerkleRoot.slice(2), 'hex');
    expect(bytes).toHaveLength(32);
    expect(bytes[0]).toBe(0xab);
  });

  it('overwrites previous entries on save', async () => {
    await journal.save([makeEntry({ ual: 'first' })]);
    await journal.save([makeEntry({ ual: 'second' }), makeEntry({ ual: 'third' })]);

    const loaded = await journal.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].ual).toBe('second');
    expect(loaded[1].ual).toBe('third');
  });
});
