import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const FINALIZATION_RECOVERY_JOURNAL_FILENAME = 'pending-finalizations.json';

const JOURNAL_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ENVELOPE_BYTES = 1024 * 1024;
const DEFAULT_RAW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type FinalizationRecoveryTrust = 'raw' | 'verified';

export interface FinalizationRecoveryEntry {
  key: string;
  state: FinalizationRecoveryTrust;
  chainId: string;
  contextGraphId: string;
  sourcePeerId?: string;
  ual: string;
  txHash: string;
  assertionVersion: string;
  merkleRoot: string;
  kaId: string;
  targetContextGraphId?: string;
  rawMessageBase64: string;
  createdAt: number;
  updatedAt: number;
}

interface JournalDocument {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  entries: FinalizationRecoveryEntry[];
}

export interface FinalizationRecoveryJournalOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxEnvelopeBytes?: number;
  rawTtlMs?: number;
  now?: () => number;
}

export interface FinalizationRecoveryUpsert {
  state: FinalizationRecoveryTrust;
  chainId: string;
  contextGraphId: string;
  sourcePeerId?: string;
  ual: string;
  txHash: string;
  assertionVersion: string;
  merkleRoot: string;
  kaId: string;
  targetContextGraphId?: string;
  rawMessage: Uint8Array;
}

export class FinalizationRecoveryJournalCorruptError extends Error {
  constructor(readonly filePath: string, cause?: unknown) {
    super(`Finalization recovery journal is corrupt: ${filePath}`, { cause });
    this.name = 'FinalizationRecoveryJournalCorruptError';
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function normalizedTxHash(value: string): string {
  return value.toLowerCase();
}

export function finalizationRecoveryEntryKey(
  input: Pick<FinalizationRecoveryUpsert, 'chainId' | 'contextGraphId' | 'ual' | 'txHash'>,
): string {
  return JSON.stringify([
    input.chainId,
    input.contextGraphId,
    input.ual,
    normalizedTxHash(input.txHash),
  ]);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseEntry(value: unknown): FinalizationRecoveryEntry {
  if (!value || typeof value !== 'object') throw new Error('entry is not an object');
  const candidate = value as Record<string, unknown>;
  if (
    !isString(candidate.key)
    || (candidate.state !== 'raw' && candidate.state !== 'verified')
    || !isString(candidate.chainId)
    || !isString(candidate.contextGraphId)
    || (candidate.sourcePeerId !== undefined && !isString(candidate.sourcePeerId))
    || !isString(candidate.ual)
    || !isString(candidate.txHash)
    || !isString(candidate.assertionVersion)
    || !isString(candidate.merkleRoot)
    || !isString(candidate.kaId)
    || (candidate.targetContextGraphId !== undefined && !isString(candidate.targetContextGraphId))
    || !isString(candidate.rawMessageBase64)
    || !Number.isSafeInteger(candidate.createdAt)
    || !Number.isSafeInteger(candidate.updatedAt)
  ) {
    throw new Error('entry has an invalid shape');
  }
  const entry = candidate as unknown as FinalizationRecoveryEntry;
  if (entry.key !== finalizationRecoveryEntryKey(entry)) throw new Error('entry key does not match identity');
  const canonicalBase64 = Buffer.from(entry.rawMessageBase64, 'base64').toString('base64');
  if (canonicalBase64 !== entry.rawMessageBase64) throw new Error('entry envelope is not canonical base64');
  return entry;
}

/**
 * Bounded receiver-local persistence for provenance-bearing V2 finalization
 * envelopes. Journal state is durability evidence only; callers must replay the
 * original envelope through all normal chain, access, and content validation.
 */
export class FinalizationRecoveryJournal {
  readonly filePath: string;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly maxEnvelopeBytes: number;
  private readonly rawTtlMs: number;
  private readonly now: () => number;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(dataDir: string, options: FinalizationRecoveryJournalOptions = {}) {
    this.filePath = join(dataDir, FINALIZATION_RECOVERY_JOURNAL_FILENAME);
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    this.maxEnvelopeBytes = positiveInteger(options.maxEnvelopeBytes, DEFAULT_MAX_ENVELOPE_BYTES);
    this.rawTtlMs = positiveInteger(options.rawTtlMs, DEFAULT_RAW_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  async list(): Promise<FinalizationRecoveryEntry[]> {
    await this.mutationTail;
    const now = this.now();
    return this.loadDocument().then((document) => document.entries
      .filter((entry) => entry.state === 'verified' || now - entry.updatedAt <= this.rawTtlMs)
      .map((entry) => ({ ...entry })));
  }

  async forKnowledgeAsset(input: {
    chainId: string;
    contextGraphId: string;
    ual: string;
    kaId: string;
  }): Promise<FinalizationRecoveryEntry[]> {
    const entries = await this.list();
    return entries.filter((entry) =>
      entry.chainId === input.chainId
      && entry.contextGraphId === input.contextGraphId
      && entry.ual === input.ual
      && entry.kaId === input.kaId,
    );
  }

  async upsert(input: FinalizationRecoveryUpsert): Promise<boolean> {
    if (input.rawMessage.byteLength > this.maxEnvelopeBytes) return false;
    return this.mutate(async (document) => {
      const now = this.now();
      document.entries = document.entries.filter((entry) =>
        entry.state === 'verified' || now - entry.updatedAt <= this.rawTtlMs,
      );
      const key = finalizationRecoveryEntryKey(input);
      const existingIndex = document.entries.findIndex((entry) => entry.key === key);
      const existing = existingIndex >= 0 ? document.entries[existingIndex] : undefined;
      const rawMessageBase64 = Buffer.from(input.rawMessage).toString('base64');
      if (
        existing
        && existing.rawMessageBase64 !== rawMessageBase64
        && input.state === 'raw'
      ) {
        return { changed: false, value: false };
      }
      const next: FinalizationRecoveryEntry = {
        key,
        state: existing?.state === 'verified' ? 'verified' : input.state,
        chainId: input.chainId,
        contextGraphId: input.contextGraphId,
        ...(existing?.sourcePeerId || input.sourcePeerId
          ? { sourcePeerId: existing?.sourcePeerId ?? input.sourcePeerId }
          : {}),
        ual: input.ual,
        txHash: input.txHash,
        assertionVersion: input.assertionVersion,
        merkleRoot: input.merkleRoot,
        kaId: input.kaId,
        ...(input.targetContextGraphId
          ? { targetContextGraphId: input.targetContextGraphId }
          : {}),
        rawMessageBase64,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const candidateEntries = [...document.entries];
      if (existingIndex >= 0) candidateEntries[existingIndex] = next;
      else candidateEntries.push(next);
      const candidate: JournalDocument = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        entries: candidateEntries,
      };
      if (
        candidate.entries.length > this.maxEntries
        || Buffer.byteLength(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8') > this.maxTotalBytes
      ) {
        return { changed: false, value: false };
      }
      document.entries = candidateEntries;
      return { changed: true, value: true };
    });
  }

  async remove(key: string): Promise<boolean> {
    return this.mutate(async (document) => {
      const entries = document.entries.filter((entry) => entry.key !== key);
      if (entries.length === document.entries.length) return { changed: false, value: false };
      document.entries = entries;
      return { changed: true, value: true };
    });
  }

  private async mutate<T>(
    operation: (document: JournalDocument) => Promise<{ changed: boolean; value: T }>,
  ): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.mutationTail = this.mutationTail.then(async () => {
      try {
        const document = await this.loadDocument();
        const outcome = await operation(document);
        if (outcome.changed) await this.saveDocument(document);
        resolveResult(outcome.value);
      } catch (error) {
        rejectResult(error);
      }
    }, async () => {
      // A failed caller operation must not permanently poison later mutations.
      try {
        const document = await this.loadDocument();
        const outcome = await operation(document);
        if (outcome.changed) await this.saveDocument(document);
        resolveResult(outcome.value);
      } catch (error) {
        rejectResult(error);
      }
    });
    await result;
    return result;
  }

  private async loadDocument(): Promise<JournalDocument> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: JOURNAL_SCHEMA_VERSION, entries: [] };
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<JournalDocument>;
      if (parsed.schemaVersion !== JOURNAL_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
        throw new Error('unsupported schema');
      }
      const entries = parsed.entries.map(parseEntry);
      if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
        throw new Error('duplicate entry keys');
      }
      return { schemaVersion: JOURNAL_SCHEMA_VERSION, entries };
    } catch (error) {
      throw new FinalizationRecoveryJournalCorruptError(this.filePath, error);
    }
  }

  private async saveDocument(document: JournalDocument): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp.${randomBytes(6).toString('hex')}`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
    await handle.close();
    try {
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
    // Directory handles are not portable (notably on Windows), so durability
    // beyond the fsynced file and atomic rename is best effort.
    try {
      const directoryHandle = await open(directory, 'r');
      await directoryHandle.sync().catch(() => {});
      await directoryHandle.close().catch(() => {});
    } catch {
      // The renamed, fsynced journal is already authoritative.
    }
  }
}
