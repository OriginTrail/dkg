import { writeFile, readFile, rename, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface JournalEntry {
  ual: string;
  contextGraphId: string;
  expectedPublisherAddress: string;
  /** Hex-encoded merkle root */
  expectedMerkleRoot: string;
  /** Stringified bigint */
  expectedStartKAId: string;
  /** Stringified bigint */
  expectedEndKAId: string;
  expectedChainId: string;
  /** Root entity IRIs from the KA manifest, used for cleanup on expiry */
  rootEntities?: string[];
  createdAt: number;
}

const JOURNAL_FILENAME = 'pending-publishes.json';

/**
 * Lightweight file-backed journal for pending publish entries.
 * Survives process restarts so tentative data in the triple store
 * can still be matched against incoming chain confirmation events.
 *
 * Uses atomic writes (temp file + rename) to avoid corruption.
 */
export class PublishJournal {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, JOURNAL_FILENAME);
  }

  async save(entries: JournalEntry[]): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });

    const tmp = this.filePath + '.tmp.' + randomBytes(4).toString('hex');
    const json = JSON.stringify(entries, null, 2);
    await writeFile(tmp, json, 'utf-8');
    await rename(tmp, this.filePath);
  }

  async load(): Promise<JournalEntry[]> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as JournalEntry[];
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }
}
