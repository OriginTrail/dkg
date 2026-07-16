import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
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

export class FileWorkspacePublicSnapshotStore implements WorkspacePublicSnapshotStore {
  constructor(private readonly directory: string) {}

  async putSnapshot(input: {
    readonly digest: string;
    readonly quads: readonly Quad[];
  }): Promise<{ readonly ref: string; readonly byteLength: number }> {
    const hash = snapshotHash(input.digest);
    const filePath = snapshotPath(this.directory, hash, 'nq');
    const payload = serializeWorkspacePublicSnapshotQuads(input.quads);

    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, payload, 'utf8');
    await rename(tempPath, filePath).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') return;
      throw err;
    });

    return {
      ref: input.digest,
      byteLength: Buffer.byteLength(payload, 'utf8'),
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

    const input = file.createReadStream({
      encoding: 'utf8',
      autoClose: false,
      signal: options?.signal,
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const page: Quad[] = [];
    let row = 0;
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

function snapshotPath(directory: string, hash: string, extension: 'json' | 'nq'): string {
  return join(directory, hash.slice(0, 2), hash.slice(2, 4), `${hash}.${extension}`);
}

export function serializeWorkspacePublicSnapshotQuads(quads: readonly Quad[]): string {
  if (quads.length === 0) return '';
  return `${quads.map(quadToNQuad).join('\n')}\n`;
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
