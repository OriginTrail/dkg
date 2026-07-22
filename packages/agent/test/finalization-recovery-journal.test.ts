import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FINALIZATION_RECOVERY_JOURNAL_FILENAME,
  FinalizationRecoveryJournal,
  FinalizationRecoveryJournalCorruptError,
  type FinalizationRecoveryUpsert,
} from '../src/finalization-recovery-journal.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-journal-'));
  directories.push(directory);
  return directory;
}

function entry(index: number, overrides: Partial<FinalizationRecoveryUpsert> = {}): FinalizationRecoveryUpsert {
  return {
    state: 'raw',
    chainId: 'base:84532',
    contextGraphId: 'public-test',
    sourcePeerId: '12D3KooWPublisher',
    ual: `did:dkg:base:84532/0x${'11'.repeat(20)}/${index}`,
    txHash: `0x${index.toString(16).padStart(64, '0')}`,
    assertionVersion: '1',
    merkleRoot: `0x${'ab'.repeat(32)}`,
    kaId: String(index),
    targetContextGraphId: '129',
    rawMessage: Uint8Array.from([index]),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe('FinalizationRecoveryJournal', () => {
  it('persists, promotes, deduplicates, and removes an envelope across instances', async () => {
    const directory = await temporaryDirectory();
    const first = new FinalizationRecoveryJournal(directory);
    expect(await first.upsert(entry(1))).toBe(true);
    expect(await first.upsert(entry(1))).toBe(true);

    const restarted = new FinalizationRecoveryJournal(directory);
    expect(await restarted.list()).toMatchObject([{
      state: 'raw',
      sourcePeerId: '12D3KooWPublisher',
      ual: entry(1).ual,
    }]);
    expect(await restarted.upsert(entry(1, { state: 'verified' }))).toBe(true);
    const [verified] = await restarted.list();
    expect(verified.state).toBe('verified');
    expect(await restarted.remove(verified.key)).toBe(true);
    expect(await new FinalizationRecoveryJournal(directory).list()).toEqual([]);

    const mode = (await stat(join(directory, FINALIZATION_RECOVERY_JOURNAL_FILENAME))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('serializes concurrent mutations without dropping entries', async () => {
    const directory = await temporaryDirectory();
    const journal = new FinalizationRecoveryJournal(directory, { maxEntries: 64 });
    await Promise.all(Array.from({ length: 40 }, (_, index) => journal.upsert(entry(index + 1))));
    const entries = await journal.list();
    expect(entries).toHaveLength(40);
    expect(new Set(entries.map((candidate) => candidate.key)).size).toBe(40);
  });

  it('expires raw entries but retains verified evidence', async () => {
    const directory = await temporaryDirectory();
    let now = 1_000;
    const journal = new FinalizationRecoveryJournal(directory, {
      rawTtlMs: 100,
      now: () => now,
    });
    await journal.upsert(entry(1));
    await journal.upsert(entry(2, { state: 'verified' }));
    now += 101;
    expect((await journal.list()).map((candidate) => candidate.kaId)).toEqual(['2']);
    await journal.upsert(entry(3));
    expect((await journal.list()).map((candidate) => candidate.kaId).sort()).toEqual(['2', '3']);
  });

  it('rejects count, total-byte, and envelope-byte overflow without evicting verified entries', async () => {
    const directory = await temporaryDirectory();
    const journal = new FinalizationRecoveryJournal(directory, {
      maxEntries: 1,
      maxTotalBytes: 2_000,
      maxEnvelopeBytes: 4,
    });
    expect(await journal.upsert(entry(1, { state: 'verified' }))).toBe(true);
    expect(await journal.upsert(entry(2))).toBe(false);
    expect(await journal.upsert(entry(3, { rawMessage: new Uint8Array(5) }))).toBe(false);
    expect(await journal.list()).toMatchObject([{ kaId: '1', state: 'verified' }]);
  });

  it('preserves a corrupt journal and refuses to overwrite it', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, FINALIZATION_RECOVERY_JOURNAL_FILENAME);
    await writeFile(path, '{ definitely-not-json', { mode: 0o600 });
    const journal = new FinalizationRecoveryJournal(directory);
    await expect(journal.list()).rejects.toBeInstanceOf(FinalizationRecoveryJournalCorruptError);
    await expect(journal.upsert(entry(1))).rejects.toBeInstanceOf(FinalizationRecoveryJournalCorruptError);
    expect(await readFile(path, 'utf8')).toBe('{ definitely-not-json');
  });

  it('does not let a conflicting raw duplicate replace the original source envelope', async () => {
    const directory = await temporaryDirectory();
    const journal = new FinalizationRecoveryJournal(directory);
    expect(await journal.upsert(entry(1))).toBe(true);
    expect(await journal.upsert(entry(1, {
      sourcePeerId: '12D3KooWAttacker',
      rawMessage: Uint8Array.from([9]),
    }))).toBe(false);
    expect(await journal.list()).toMatchObject([{
      sourcePeerId: '12D3KooWPublisher',
      rawMessageBase64: Buffer.from([1]).toString('base64'),
    }]);
  });
});
