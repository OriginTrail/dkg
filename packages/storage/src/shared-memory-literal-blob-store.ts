import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ConstructResult,
  Quad,
  QueryOptions,
  QueryResult,
  SelectResult,
  StorePressureSnapshot,
  TripleStore,
} from './triple-store.js';

export const EXTERNAL_LITERAL_REF_DATATYPE = 'http://dkg.io/ontology/externalLiteralRef';
export const SHARED_MEMORY_GRAPH_SUFFIX = '/_shared_memory';
export const DEFAULT_LARGE_LITERAL_THRESHOLD_BYTES = 65_536;

export interface SharedMemoryLiteralBlobStoreOptions {
  /**
   * Directory containing content-addressed RDF literal term blobs.
   * Files are named `<sha256>` and contain the exact serialized
   * RDF object term string received by `insert`.
   */
  blobDir: string;
  /**
   * Externalize SWM literal object terms whose UTF-8 serialized term size
   * is strictly greater than this value.
   */
  thresholdBytes: number;
}

export class SharedMemoryLiteralBlobStore implements TripleStore {
  get queryCancellation() {
    return this.inner.queryCancellation;
  }

  getPressureSnapshot(): StorePressureSnapshot | undefined {
    return this.inner.getPressureSnapshot?.();
  }

  readonly innerStore: TripleStore;
  private readonly inner: TripleStore;
  private readonly blobDir: string;
  private readonly thresholdBytes: number;
  private readonly pendingBlobWrites = new Map<string, Promise<void>>();

  constructor(inner: TripleStore, options: SharedMemoryLiteralBlobStoreOptions) {
    if (!options.blobDir?.trim()) {
      throw new Error('SharedMemoryLiteralBlobStore requires options.blobDir');
    }
    if (!Number.isSafeInteger(options.thresholdBytes) || options.thresholdBytes < 0) {
      throw new Error('SharedMemoryLiteralBlobStore requires a non-negative integer thresholdBytes');
    }
    this.inner = inner;
    this.innerStore = inner;
    this.blobDir = options.blobDir;
    this.thresholdBytes = options.thresholdBytes;
  }

  async insert(quads: Quad[], options?: QueryOptions): Promise<void> {
    if (quads.length === 0) return this.inner.insert(quads, options);
    const externalized = await Promise.all(
      quads.map((quad) => this.externalizeInsertQuad(quad)),
    );
    return this.inner.insert(externalized, options);
  }

  async delete(quads: Quad[], options?: QueryOptions): Promise<void> {
    if (quads.length === 0) return this.inner.delete(quads, options);
    return this.inner.delete(quads.map((quad) => this.translateDeleteQuad(quad)), options);
  }

  async deleteByPattern(pattern: Partial<Quad>, options?: QueryOptions): Promise<number> {
    const translated = this.translateDeletePattern(pattern);
    if (!Array.isArray(translated)) {
      return this.inner.deleteByPattern(translated, options);
    }

    let removed = 0;
    for (const item of translated) {
      removed += await this.inner.deleteByPattern(item, options);
    }
    return removed;
  }

  async update(sparql: string, options?: QueryOptions): Promise<void> {
    if (typeof this.inner.update !== 'function') {
      throw new Error('SharedMemoryLiteralBlobStore: inner store does not support update()');
    }
    // Forward verbatim. A server-side INSERT…WHERE copies whatever terms are
    // already stored — including any externalized blob-ref placeholders — so
    // there is nothing to externalize (the blob is shared by content hash and
    // a copied placeholder rehydrates identically through `query`). Re-running
    // externalization here is impossible anyway: an arbitrary UPDATE string
    // carries no quad objects to inspect.
    return this.inner.update(sparql, options);
  }

  async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    const rewritten = this.rewriteLargeLiteralConstants(sparql);
    if (!rewritten) {
      const result = await this.inner.query(sparql, options);
      return this.hydrateQueryResult(result);
    }

    const [original, placeholder] = await Promise.all([
      this.inner.query(sparql, options),
      this.inner.query(rewritten, options),
    ]);
    return this.hydrateQueryResult(mergeQueryResults(original, placeholder));
  }

  async hasGraph(graphUri: string): Promise<boolean> {
    return this.inner.hasGraph(graphUri);
  }

  async createGraph(graphUri: string): Promise<void> {
    return this.inner.createGraph(graphUri);
  }

  async dropGraph(graphUri: string, options?: QueryOptions): Promise<void> {
    return this.inner.dropGraph(graphUri, options);
  }

  async listGraphs(options?: QueryOptions): Promise<string[]> {
    return this.inner.listGraphs(options);
  }

  async listGraphsByPrefix(prefix: string, options?: QueryOptions): Promise<string[]> {
    return this.inner.listGraphsByPrefix
      ? this.inner.listGraphsByPrefix(prefix, options)
      : (await this.inner.listGraphs(options)).filter((graph) => graph.startsWith(prefix));
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    return this.inner.deleteBySubjectPrefix(graphUri, prefix, options);
  }

  async countQuads(graphUri?: string, options?: QueryOptions): Promise<number> {
    return this.inner.countQuads(graphUri, options);
  }

  async flush(options?: QueryOptions): Promise<void> {
    await this.inner.flush?.(options);
  }

  async close(): Promise<void> {
    return this.inner.close();
  }

  private async externalizeInsertQuad(quad: Quad): Promise<Quad> {
    if (!shouldExternalizeLiteral(quad, this.thresholdBytes)) return quad;

    const hash = sha256Term(quad.object);
    await this.writeBlob(hash, quad.object);
    return { ...quad, object: externalLiteralRefTerm(hash) };
  }

  private translateDeleteQuad(quad: Quad): Quad {
    if (!shouldExternalizeLiteral(quad, this.thresholdBytes)) return quad;
    return { ...quad, object: externalLiteralRefTerm(sha256Term(quad.object)) };
  }

  private translateDeletePattern(pattern: Partial<Quad>): Partial<Quad> | Array<Partial<Quad>> {
    if (
      !pattern.object ||
      !isSerializedLiteralObjectTerm(pattern.object) ||
      externalLiteralRefHash(pattern.object) ||
      serializedTermByteLength(pattern.object) <= this.thresholdBytes
    ) {
      return pattern;
    }

    const placeholderPattern = {
      ...pattern,
      object: externalLiteralRefTerm(sha256Term(pattern.object)),
    };

    if (pattern.graph) {
      return isSharedMemoryGraph(pattern.graph) ? placeholderPattern : pattern;
    }

    // Without a graph constraint, preserve normal deleteByPattern semantics for
    // inline triples while also deleting the SWM placeholder form.
    return [pattern, placeholderPattern];
  }

  private async hydrateQueryResult(result: QueryResult): Promise<QueryResult> {
    if (result.type === 'boolean') return result;
    const cache = new Map<string, Promise<string>>();

    if (result.type === 'bindings') {
      const bindings = await Promise.all(
        result.bindings.map(async (row) => {
          const hydrated: Record<string, string> = {};
          for (const [key, value] of Object.entries(row)) {
            hydrated[key] = await this.hydrateTerm(value, cache);
          }
          return hydrated;
        }),
      );
      return { type: 'bindings', bindings } satisfies SelectResult;
    }

    const quads = await Promise.all(
      result.quads.map(async (quad) => ({
        ...quad,
        object: await this.hydrateTerm(quad.object, cache),
      })),
    );
    return { type: 'quads', quads } satisfies ConstructResult;
  }

  private async hydrateTerm(term: string, cache: Map<string, Promise<string>>): Promise<string> {
    const hash = externalLiteralRefHash(term);
    if (!hash) return term;
    let pending = cache.get(hash);
    if (!pending) {
      pending = this.readBlob(hash);
      cache.set(hash, pending);
    }
    return pending;
  }

  private rewriteLargeLiteralConstants(sparql: string): string | undefined {
    const rewritten = rewriteSerializedLiteralTerms(sparql, (term) => {
      if (!isSerializedLiteralObjectTerm(term)) return term;
      if (externalLiteralRefHash(term)) return term;
      if (serializedTermByteLength(term) <= this.thresholdBytes) return term;
      return externalLiteralRefTerm(sha256Term(term));
    });
    return rewritten === sparql ? undefined : rewritten;
  }

  private async writeBlob(hash: string, term: string): Promise<void> {
    assertSha256Hex(hash);
    const pending = this.pendingBlobWrites.get(hash);
    if (pending) {
      await pending;
      await this.readBlob(hash);
      return;
    }

    const write = this.writeBlobFile(hash, term);
    this.pendingBlobWrites.set(hash, write);
    try {
      await write;
    } finally {
      this.pendingBlobWrites.delete(hash);
    }
  }

  private async writeBlobFile(hash: string, term: string): Promise<void> {
    await mkdir(this.blobDir, { recursive: true });
    const path = this.blobPath(hash);

    try {
      await writeFile(path, term, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      if (isNodeError(err, 'EEXIST')) {
        await this.readBlob(hash);
        return;
      }
      throw err;
    }

    await this.readBlob(hash);
  }

  private async readBlob(hash: string): Promise<string> {
    assertSha256Hex(hash);
    const path = this.blobPath(hash);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (err) {
      if (isNodeError(err, 'ENOENT')) {
        throw new Error(`SWM external literal blob missing for sha256:${hash} at ${path}`);
      }
      throw err;
    }

    const actual = sha256Term(content);
    if (actual !== hash) {
      throw new Error(
        `SWM external literal blob corrupt for sha256:${hash} at ${path}: found sha256:${actual}`,
      );
    }
    return content;
  }

  private blobPath(hash: string): string {
    return join(this.blobDir, hash);
  }
}

function shouldExternalizeLiteral(quad: Quad, thresholdBytes: number): boolean {
  return (
    isSharedMemoryGraph(quad.graph) &&
    isSerializedLiteralObjectTerm(quad.object) &&
    !externalLiteralRefHash(quad.object) &&
    serializedTermByteLength(quad.object) > thresholdBytes
  );
}

function isSharedMemoryGraph(graph: string | undefined): boolean {
  return Boolean(graph && graph.endsWith(SHARED_MEMORY_GRAPH_SUFFIX));
}

function serializedTermByteLength(term: string): number {
  return Buffer.byteLength(term, 'utf8');
}

function isSerializedLiteralObjectTerm(term: string): boolean {
  if (!term.startsWith('"')) return false;
  const closingQuote = findClosingLiteralQuote(term);
  if (closingQuote < 0) return false;
  const suffix = term.slice(closingQuote + 1);
  return (
    suffix === '' ||
    /^@[A-Za-z]+(?:-[A-Za-z0-9]+)*$/.test(suffix) ||
    /^\^\^(?:<[^>]+>|[^\s]+)$/.test(suffix)
  );
}

function findClosingLiteralQuote(term: string): number {
  for (let i = 1; i < term.length; i += 1) {
    if (term[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && term[j] === '\\'; j -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

function externalLiteralRefTerm(hash: string): string {
  assertSha256Hex(hash);
  return `"sha256:${hash}"^^<${EXTERNAL_LITERAL_REF_DATATYPE}>`;
}

function externalLiteralRefHash(term: string): string | null {
  const match = term.match(EXTERNAL_LITERAL_REF_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

function rewriteSerializedLiteralTerms(
  sparql: string,
  rewrite: (term: string) => string,
): string {
  let output = '';
  let cursor = 0;

  while (cursor < sparql.length) {
    const start = sparql.indexOf('"', cursor);
    if (start < 0) {
      output += sparql.slice(cursor);
      break;
    }

    output += sparql.slice(cursor, start);
    const parsed = readSparqlLiteralToken(sparql, start);
    if (!parsed) {
      output += sparql[start];
      cursor = start + 1;
      continue;
    }

    output += rewrite(parsed.term);
    cursor = parsed.end;
  }

  return output;
}

function readSparqlLiteralToken(input: string, start: number): { term: string; end: number } | undefined {
  const close = findClosingLiteralQuoteFrom(input, start);
  if (close < 0) return undefined;

  let end = close + 1;
  if (input[end] === '@') {
    end += 1;
    while (end < input.length && /[A-Za-z0-9-]/.test(input[end])) end += 1;
  } else if (input.slice(end, end + 2) === '^^') {
    end += 2;
    if (input[end] === '<') {
      const datatypeEnd = input.indexOf('>', end + 1);
      if (datatypeEnd < 0) return undefined;
      end = datatypeEnd + 1;
    } else {
      while (end < input.length && !/[\s;,.()[\]{}]/.test(input[end])) end += 1;
    }
  }

  return { term: input.slice(start, end), end };
}

function findClosingLiteralQuoteFrom(term: string, start: number): number {
  for (let i = start + 1; i < term.length; i += 1) {
    if (term[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= start && term[j] === '\\'; j -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

function mergeQueryResults(first: QueryResult, second: QueryResult): QueryResult {
  if (first.type !== second.type) {
    return first.type === 'boolean'
      ? first
      : second.type === 'boolean'
        ? second
        : first;
  }

  if (first.type === 'boolean' && second.type === 'boolean') {
    return { type: 'boolean', value: first.value || second.value };
  }

  if (first.type === 'bindings' && second.type === 'bindings') {
    const seen = new Set<string>();
    const bindings = [...first.bindings, ...second.bindings].filter((row) => {
      const key = stableRecordKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { type: 'bindings', bindings };
  }

  const seen = new Set<string>();
  const quads = [
    ...(first as ConstructResult).quads,
    ...(second as ConstructResult).quads,
  ].filter((quad) => {
    const key = `${quad.subject}\n${quad.predicate}\n${quad.object}\n${quad.graph}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { type: 'quads', quads };
}

function stableRecordKey(row: Record<string, string>): string {
  return JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
}

function sha256Term(term: string): string {
  return createHash('sha256').update(term, 'utf8').digest('hex');
}

function assertSha256Hex(hash: string): void {
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error(`Invalid sha256 literal blob key: ${hash}`);
  }
}

function isNodeError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === code;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const EXTERNAL_LITERAL_REF_PATTERN = new RegExp(
  `^"sha256:([a-fA-F0-9]{64})"\\^\\^<${escapeRegExp(EXTERNAL_LITERAL_REF_DATATYPE)}>$`,
);
