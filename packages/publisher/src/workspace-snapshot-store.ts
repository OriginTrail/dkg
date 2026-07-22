import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Quad } from '@origintrail-official/dkg-storage';

export interface SharedMemoryPublicSnapshotStorageConfig {
  enabled?: boolean;
  directory?: string;
}

export interface WorkspacePublicSnapshotStore {
  putSnapshot(input: {
    readonly digest: string;
    readonly quads: readonly Quad[];
  }): Promise<{ readonly ref: string; readonly byteLength: number }>;
  getSnapshot(ref: string): Promise<Quad[] | null>;
  /**
   * Read one immutable snapshot page without materializing the complete file.
   * Optional for compatibility with custom/legacy stores; sync responders fall
   * back to `getSnapshot().slice(...)` when it is not implemented.
   */
  getSnapshotPage?(
    ref: string,
    offset: number,
    limit: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Quad[] | null>;
}

export interface SnapshotPageIndexRecord {
  readonly snapshotDigest: string;
  readonly formatVersion: number;
  readonly stride: number;
  readonly snapshotFileSize: number;
  readonly modificationFingerprint: string;
  readonly offsetCount: number;
  readonly offsetsBlob: Uint8Array;
  readonly checksum: string;
}

export interface SnapshotPageIndexStore {
  get(snapshotDigest: string): Promise<SnapshotPageIndexRecord | null>;
  upsert(record: SnapshotPageIndexRecord): Promise<void>;
}

const SNAPSHOT_PAGE_INDEX_VERSION = 1;
const SNAPSHOT_PAGE_INDEX_STRIDE = 128;
const SNAPSHOT_PAGE_INDEX_CACHE_MAX = 64;

interface SnapshotPageIndexCore {
  version: typeof SNAPSHOT_PAGE_INDEX_VERSION;
  stride: number;
  offsets: number[];
  fileBytes: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface SnapshotFileFingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export class FileWorkspacePublicSnapshotStore implements WorkspacePublicSnapshotStore {
  private readonly pageIndexCache = new Map<string, Promise<SnapshotPageIndexCore>>();

  constructor(
    private readonly directory: string,
    private readonly pageIndexStore?: SnapshotPageIndexStore,
  ) {}

  async putSnapshot(input: {
    readonly digest: string;
    readonly quads: readonly Quad[];
  }): Promise<{ readonly ref: string; readonly byteLength: number }> {
    const hash = snapshotHash(input.digest);
    const filePath = snapshotPath(this.directory, hash, 'nq');
    const { payload, offsets, fileBytes } = serializeWorkspacePublicSnapshotWithIndex(input.quads);

    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, payload, 'utf8');
    await rename(tempPath, filePath).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') return;
      throw err;
    });

    const fingerprint = await stat(filePath);
    const index: SnapshotPageIndexCore = {
      version: SNAPSHOT_PAGE_INDEX_VERSION,
      stride: SNAPSHOT_PAGE_INDEX_STRIDE,
      offsets,
      fileBytes,
      mtimeMs: fingerprint.mtimeMs,
      ctimeMs: fingerprint.ctimeMs,
    };
    await this.persistSnapshotPageIndexBestEffort(input.digest, index);
    this.rememberPageIndex(input.digest, Promise.resolve(index));

    return {
      ref: input.digest,
      byteLength: fileBytes,
    };
  }

  async getSnapshot(ref: string): Promise<Quad[] | null> {
    const hash = snapshotHash(ref);
    const nquadsPath = snapshotPath(this.directory, hash, 'nq');
    let raw: string;
    try {
      raw = await readFile(nquadsPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return this.getLegacyJsonSnapshot(ref, hash);
    }

    return parseWorkspacePublicSnapshotNQuads(raw, ref);
  }

  async getSnapshotPage(
    ref: string,
    offset: number,
    limit: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Quad[] | null> {
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(0, Math.floor(limit));
    if (safeLimit === 0) return [];
    const hash = snapshotHash(ref);
    const nquadsPath = snapshotPath(this.directory, hash, 'nq');
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(nquadsPath, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const legacy = await this.getLegacyJsonSnapshot(ref, hash);
      return legacy?.slice(safeOffset, safeOffset + safeLimit) ?? null;
    }

    let startRow = 0;
    let startByte = 0;
    try {
      const index = await this.getPageIndex(ref, nquadsPath);
      const checkpoint = Math.min(
        Math.floor(safeOffset / index.stride),
        Math.max(0, index.offsets.length - 1),
      );
      startRow = checkpoint * index.stride;
      startByte = index.offsets[checkpoint] ?? 0;
    } catch {
      // Page indexes are derived data. The already-open snapshot remains the
      // source of truth, so index failures fall back to scanning from row zero.
    }

    const input = file.createReadStream({
      encoding: 'utf8',
      autoClose: false,
      start: startByte,
      signal: options?.signal,
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const page: Quad[] = [];
    let row = startRow;
    try {
      for await (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (row >= safeOffset) {
          page.push(parseNQuadLine(line, ref, row));
          if (page.length >= safeLimit) break;
        }
        row += 1;
      }
      return page;
    } finally {
      lines.close();
      input.destroy();
      await file.close().catch(() => {});
    }
  }

  private getPageIndex(ref: string, nquadsPath: string): Promise<SnapshotPageIndexCore> {
    const existing = this.pageIndexCache.get(ref);
    if (existing) {
      this.rememberPageIndex(ref, existing);
      return existing;
    }
    const load = this.loadOrBuildPageIndex(ref, nquadsPath).catch((error) => {
      if (this.pageIndexCache.get(ref) === load) this.pageIndexCache.delete(ref);
      throw error;
    });
    this.rememberPageIndex(ref, load);
    return load;
  }

  private async loadOrBuildPageIndex(
    ref: string,
    nquadsPath: string,
  ): Promise<SnapshotPageIndexCore> {
    const fingerprint = await stat(nquadsPath);
    if (this.pageIndexStore) {
      try {
        const record = await this.pageIndexStore.get(canonicalSnapshotDigest(ref));
        const index = decodeSnapshotPageIndexRecord(record, fingerprint, ref);
        if (index) return index;
      } catch {
        // The index is derived data; a failed SQLite read must not block paging.
      }
    }

    const index = await buildSnapshotPageIndex(nquadsPath);
    await this.persistSnapshotPageIndexBestEffort(ref, index);
    return index;
  }

  private rememberPageIndex(ref: string, index: Promise<SnapshotPageIndexCore>): void {
    this.pageIndexCache.delete(ref);
    this.pageIndexCache.set(ref, index);
    while (this.pageIndexCache.size > SNAPSHOT_PAGE_INDEX_CACHE_MAX) {
      const oldest = this.pageIndexCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.pageIndexCache.delete(oldest);
    }
  }

  private async persistSnapshotPageIndexBestEffort(
    ref: string,
    index: SnapshotPageIndexCore,
  ): Promise<void> {
    if (!this.pageIndexStore) return;
    try {
      const offsetsBlob = encodeSnapshotPageIndexOffsets(index.offsets);
      const recordCore = {
        snapshotDigest: canonicalSnapshotDigest(ref),
        formatVersion: index.version,
        stride: index.stride,
        snapshotFileSize: index.fileBytes,
        modificationFingerprint: snapshotModificationFingerprint(index),
        offsetCount: index.offsets.length,
        offsetsBlob,
      };
      await this.pageIndexStore.upsert({
        ...recordCore,
        checksum: snapshotPageIndexRecordChecksum(recordCore),
      });
    } catch {
      // The index is derived data; snapshot writes and reads remain usable.
    }
  }

  private async getLegacyJsonSnapshot(ref: string, hash: string): Promise<Quad[] | null> {
    const jsonPath = snapshotPath(this.directory, hash, 'json');
    let raw: string;
    try {
      raw = await readFile(jsonPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((entry) => {
      if (!Array.isArray(entry) || entry.length < 3) {
        throw new Error(`Invalid shared-memory public snapshot blob ${ref}`);
      }
      return {
        subject: String(entry[0]),
        predicate: String(entry[1]),
        object: String(entry[2]),
        graph: '',
      };
    });
  }
}

function snapshotHash(ref: string): string {
  const trimmed = ref.trim();
  const hash = trimmed.startsWith('sha256:') ? trimmed.slice('sha256:'.length) : trimmed;
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error(`Invalid shared-memory public snapshot ref ${ref}`);
  }
  return hash.toLowerCase();
}

function canonicalSnapshotDigest(ref: string): string {
  return `sha256:${snapshotHash(ref)}`;
}

function snapshotPath(directory: string, hash: string, extension: 'json' | 'nq'): string {
  return join(directory, hash.slice(0, 2), hash.slice(2, 4), `${hash}.${extension}`);
}

function serializeWorkspacePublicSnapshotWithIndex(quads: readonly Quad[]): {
  payload: string;
  offsets: number[];
  fileBytes: number;
} {
  if (quads.length === 0) return { payload: '', offsets: [0], fileBytes: 0 };
  const lines = quads.map(quadToNQuad);
  const offsets = [0];
  let fileBytes = 0;
  for (let row = 0; row < lines.length; row += 1) {
    fileBytes += Buffer.byteLength(lines[row]!, 'utf8') + 1;
    if (isSnapshotPageIndexCheckpoint(row + 1)) offsets.push(fileBytes);
  }
  return { payload: `${lines.join('\n')}\n`, offsets, fileBytes };
}

async function buildSnapshotPageIndex(nquadsPath: string): Promise<SnapshotPageIndexCore> {
  const file = await open(nquadsPath, 'r');
  const offsets = [0];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let absoluteOffset = 0;
  let rows = 0;
  try {
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, absoluteOffset);
      if (bytesRead === 0) break;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        rows += 1;
        if (isSnapshotPageIndexCheckpoint(rows)) {
          offsets.push(absoluteOffset + index + 1);
        }
      }
      absoluteOffset += bytesRead;
    }
  } finally {
    await file.close();
  }
  const fingerprint = await stat(nquadsPath);
  return {
    version: SNAPSHOT_PAGE_INDEX_VERSION,
    stride: SNAPSHOT_PAGE_INDEX_STRIDE,
    offsets,
    fileBytes: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs,
    ctimeMs: fingerprint.ctimeMs,
  };
}

function isSnapshotPageIndexCheckpoint(row: number): boolean {
  return row > 0 && row % SNAPSHOT_PAGE_INDEX_STRIDE === 0;
}

function snapshotModificationFingerprint(
  index: Pick<SnapshotPageIndexCore, 'mtimeMs' | 'ctimeMs'>,
): string {
  return `${index.mtimeMs}:${index.ctimeMs}`;
}

function encodeSnapshotPageIndexOffsets(offsets: readonly number[]): Uint8Array {
  const blob = Buffer.allocUnsafe(offsets.length * 8);
  offsets.forEach((offset, position) => {
    blob.writeBigUInt64BE(BigInt(offset), position * 8);
  });
  return blob;
}

function snapshotPageIndexRecordChecksum(
  record: Omit<SnapshotPageIndexRecord, 'checksum'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      record.snapshotDigest,
      record.formatVersion,
      record.stride,
      record.snapshotFileSize,
      record.modificationFingerprint,
      record.offsetCount,
    ]))
    .update(record.offsetsBlob)
    .digest('hex');
}

function decodeSnapshotPageIndexRecord(
  value: SnapshotPageIndexRecord | null,
  fingerprint: SnapshotFileFingerprint,
  ref: string,
): SnapshotPageIndexCore | null {
  if (!value || typeof value !== 'object') return null;
  if (
    value.snapshotDigest !== canonicalSnapshotDigest(ref)
    || value.formatVersion !== SNAPSHOT_PAGE_INDEX_VERSION
    || value.stride !== SNAPSHOT_PAGE_INDEX_STRIDE
    || value.snapshotFileSize !== fingerprint.size
    || value.modificationFingerprint !== snapshotModificationFingerprint(fingerprint)
    || !Number.isSafeInteger(value.offsetCount)
    || value.offsetCount <= 0
    || !(value.offsetsBlob instanceof Uint8Array)
    || value.offsetsBlob.byteLength !== value.offsetCount * 8
    || typeof value.checksum !== 'string'
    || value.checksum !== snapshotPageIndexRecordChecksum(value)
  ) return null;

  const blob = Buffer.from(value.offsetsBlob);
  const offsets: number[] = [];
  let previous = -1;
  for (let position = 0; position < value.offsetCount; position += 1) {
    const offsetBigInt = blob.readBigUInt64BE(position * 8);
    if (offsetBigInt > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const offset = Number(offsetBigInt);
    if (offset < previous || offset > fingerprint.size) return null;
    offsets.push(offset);
    previous = offset;
  }
  if (offsets[0] !== 0) return null;

  return {
    version: SNAPSHOT_PAGE_INDEX_VERSION,
    stride: SNAPSHOT_PAGE_INDEX_STRIDE,
    offsets,
    fileBytes: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs,
    ctimeMs: fingerprint.ctimeMs,
  };
}

export function serializeWorkspacePublicSnapshotQuads(quads: readonly Quad[]): string {
  return serializeWorkspacePublicSnapshotWithIndex(quads).payload;
}

export function workspacePublicQuadsDigest(quads: readonly Quad[]): string {
  const canonical = quads
    .map((quad) => [quad.subject, quad.predicate, quad.object, ''])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const hash = createHash('sha256');
  hash.update(JSON.stringify(canonical));
  return `sha256:${hash.digest('hex')}`;
}

function quadToNQuad(quad: Quad): string {
  return `${formatNodeTerm(quad.subject)} <${escapeIri(quad.predicate)}> ${formatObjectTerm(quad.object)} .`;
}

function formatNodeTerm(term: string): string {
  if (term.startsWith('_:')) return term;
  if (term.startsWith('<') && term.endsWith('>')) return term;
  return `<${escapeIri(term)}>`;
}

function formatObjectTerm(term: string): string {
  if (term.startsWith('"')) {
    const bareDatatype = term.match(/^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/);
    return bareDatatype ? `${bareDatatype[1]}^^<${escapeIri(bareDatatype[2])}>` : term;
  }
  return formatNodeTerm(term);
}

function escapeIri(iri: string): string {
  return iri.replace(/[<>"{}|\\^`]/g, '');
}

export function parseWorkspacePublicSnapshotNQuads(raw: string, ref: string): Quad[] {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => parseNQuadLine(line, ref, index));
}

function parseNQuadLine(line: string, ref: string, index: number): Quad {
  const parsedSubject = readTerm(line, 0);
  if (!parsedSubject) throw invalidSnapshotBlob(ref, index);

  const parsedPredicate = readTerm(line, parsedSubject.end);
  if (!parsedPredicate || !isIriTerm(parsedPredicate.term)) throw invalidSnapshotBlob(ref, index);

  const parsedObject = readTerm(line, parsedPredicate.end);
  if (!parsedObject) throw invalidSnapshotBlob(ref, index);

  const rest = line.slice(parsedObject.end).trim();
  if (rest !== '.') throw invalidSnapshotBlob(ref, index);

  return {
    subject: normalizeParsedResourceTerm(parsedSubject.term),
    predicate: normalizeParsedResourceTerm(parsedPredicate.term),
    object: normalizeParsedObjectTerm(parsedObject.term),
    graph: '',
  };
}

function readTerm(input: string, start: number): { term: string; end: number } | null {
  let cursor = skipWhitespace(input, start);
  if (cursor >= input.length) return null;

  if (input[cursor] === '<') {
    const end = input.indexOf('>', cursor + 1);
    if (end < 0) return null;
    return { term: input.slice(cursor, end + 1), end: end + 1 };
  }

  if (input.startsWith('_:', cursor)) {
    const end = readUntilWhitespace(input, cursor);
    return { term: input.slice(cursor, end), end };
  }

  if (input[cursor] === '"') {
    return readLiteralTerm(input, cursor);
  }

  return null;
}

function readLiteralTerm(input: string, start: number): { term: string; end: number } | null {
  const quoteEnd = findClosingLiteralQuote(input, start);
  if (quoteEnd < 0) return null;

  let end = quoteEnd + 1;
  if (input[end] === '@') {
    end += 1;
    while (end < input.length && /[A-Za-z0-9-]/.test(input[end])) end += 1;
  } else if (input.slice(end, end + 2) === '^^') {
    end += 2;
    if (input[end] === '<') {
      const datatypeEnd = input.indexOf('>', end + 1);
      if (datatypeEnd < 0) return null;
      end = datatypeEnd + 1;
    } else {
      end = readUntilWhitespace(input, end);
    }
  }

  return { term: input.slice(start, end), end };
}

function findClosingLiteralQuote(input: string, start: number): number {
  for (let i = start + 1; i < input.length; i += 1) {
    if (input[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= start && input[j] === '\\'; j -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

function skipWhitespace(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length && /\s/.test(input[cursor])) cursor += 1;
  return cursor;
}

function readUntilWhitespace(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length && !/\s/.test(input[cursor])) cursor += 1;
  return cursor;
}

function isIriTerm(term: string): boolean {
  return term.startsWith('<') && term.endsWith('>');
}

function normalizeParsedResourceTerm(term: string): string {
  if (isIriTerm(term)) return term.slice(1, -1);
  return term;
}

function normalizeParsedObjectTerm(term: string): string {
  return isIriTerm(term) ? term.slice(1, -1) : term;
}

function invalidSnapshotBlob(ref: string, index: number): Error {
  return new Error(`Invalid shared-memory public snapshot blob ${ref} at line ${index + 1}`);
}
