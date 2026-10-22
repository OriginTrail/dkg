import type { ImmutableStorePreparation, PreparedInsert, PreparedMutation } from './immutable-store-preparation.js';
import { DurableDirectoryPreparation } from './durable-content-addressed-file.js';
import { persistFileDirectoryEntries } from './file-durability.js';
import type { TripleStoreCommitCapability } from './persistence.js';
import type { AtomicAssetReplacement } from './atomic-asset-group.js';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LiteralHydrationBudget, readLiteralBlobBounded } from './bounded-literal-hydration.js';
import type {
  ConstructResult,
  Quad,
  QueryOptions,
  UpdateOptions,
  QueryResult,
  SelectResult,
  StorePressureSnapshot,
  TripleStore,
  TripleStoreDecorator,
} from './triple-store.js';
import { deleteByPatternWithoutCount } from './triple-store.js';
import { UnsupportedTripleStoreCapabilityError } from './unsupported-capability-error.js';
import { assertSubjectAndInsertPayload } from './atomic-subject-insert.js';
import type {
  Rfc64AuthorCommitCasInputV1,
  Rfc64AuthorCommitCasResultV1,
} from './rfc64-author-commit-cas.js';
import {
  mapRfc64AuthorCommitCasV1,
  normalizeRfc64AuthorCommitCasV1,
  sourceFromNormalizedRfc64AuthorCommitCasV1,
} from './rfc64-author-commit-cas.js';
import {
  ContentAddressedBlobSingleFlight,
} from './content-addressed-blob-single-flight.js';

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

export class SharedMemoryLiteralBlobStore implements TripleStoreDecorator, ImmutableStorePreparation {
  get queryCancellation() {
    return this.inner.queryCancellation;
  }

  getPressureSnapshot(): StorePressureSnapshot | undefined {
    return this.inner.getPressureSnapshot?.();
  }

  readonly innerStore: TripleStore;
  readonly commitment?: TripleStoreCommitCapability;
  readonly graphEnumerationVisibility;
  private readonly inner: TripleStore;
  private readonly blobDir: string;
  private readonly thresholdBytes: number;
  private readonly blobWrites: ContentAddressedBlobSingleFlight;
  private readonly blobDirectory: DurableDirectoryPreparation;

  constructor(inner: TripleStore, options: SharedMemoryLiteralBlobStoreOptions) {
    if (!options.blobDir?.trim()) {
      throw new Error('SharedMemoryLiteralBlobStore requires options.blobDir');
    }
    if (!Number.isSafeInteger(options.thresholdBytes) || options.thresholdBytes < 0) {
      throw new Error('SharedMemoryLiteralBlobStore requires a non-negative integer thresholdBytes');
    }
    this.inner = inner;
    this.innerStore = inner;
    this.commitment = inner.commitment;
    this.graphEnumerationVisibility = inner.graphEnumerationVisibility?.bind(inner);
    // Match blobPath's lexical dot-segment handling before any filesystem work.
    // Otherwise a symlink followed by '..' can prepare/sync a different parent.
    this.blobDir = resolve(options.blobDir);
    this.thresholdBytes = options.thresholdBytes;
    this.blobDirectory = new DurableDirectoryPreparation(this.blobDir);
    this.blobWrites = new ContentAddressedBlobSingleFlight({
      createOrVerify: (hash, term) => this.writeBlobFile(hash, term),
    });
  }

  async insert(quads: Quad[], options?: QueryOptions): Promise<void> {
    return (await this.prepareImmutableInsert(this.inner, quads))([], options);
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

  async deleteByPatternWithoutCount(
    pattern: Partial<Quad>,
    options?: QueryOptions,
  ): Promise<void> {
    const translated = this.translateDeletePattern(pattern);
    if (!Array.isArray(translated)) {
      await deleteByPatternWithoutCount(this.inner, translated, options);
      return;
    }
    for (const item of translated) {
      await deleteByPatternWithoutCount(this.inner, item, options);
    }
  }

  async replaceGraph(graphUri: string, quads: Quad[], options?: QueryOptions): Promise<void> {
    return (await this.prepareImmutableReplaceGraph(this.inner, graphUri, quads))(options);
  }

  async replaceAssetGroup(assets: readonly AtomicAssetReplacement[], options?: QueryOptions): Promise<void> {
    return (await this.prepareImmutableReplaceAssetGroup(this.inner, assets))(options);
  }

  async replaceGraphAndSubject(graphUri: string, graphQuads: Quad[], metaGraphUri: string,
    metadataSubject: string, metadataQuads: Quad[], options?: QueryOptions): Promise<void> {
    return (await this.prepareImmutableReplaceGraphAndSubject(this.inner, graphUri, graphQuads,
      metaGraphUri, metadataSubject, metadataQuads))(options);
  }

  async replaceSubject(graphUri: string, subject: string, quads: Quad[], options?: QueryOptions): Promise<void> {
    return (await this.prepareImmutableReplaceSubject(this.inner, graphUri, subject, quads))(options);
  }

  async replaceSubjectAndInsert(graphUri: string, subject: string, replacementQuads: Quad[], insertQuads: Quad[],
    options?: QueryOptions): Promise<void> {
    return (await this.prepareImmutableReplaceSubjectAndInsert(this.inner, graphUri, subject, replacementQuads, insertQuads))(options);
  }

  async rfc64AuthorCommitCasV1(input: Rfc64AuthorCommitCasInputV1, options?: QueryOptions): Promise<Rfc64AuthorCommitCasResultV1> {
    return (await this.prepareImmutableAuthorCommit(this.inner, input))(options);
  }

  async prepareImmutableInsert(target: TripleStore, quads: readonly Quad[]): Promise<PreparedInsert> {
    const prepared = await this.externalizeQuads(quads);
    return (appended, options) => target.insert([...prepared, ...appended], options);
  }

  async prepareImmutableReplaceGraph(target: TripleStore, graphUri: string, quads: readonly Quad[]): Promise<PreparedMutation> {
    if (!target.replaceGraph) throw new UnsupportedTripleStoreCapabilityError('replaceGraph', 'SharedMemoryLiteralBlobStore');
    const prepared = await this.externalizeQuads(quads);
    return options => target.replaceGraph!(graphUri, prepared, options);
  }

  async prepareImmutableReplaceAssetGroup(target: TripleStore, assets: readonly AtomicAssetReplacement[]): Promise<PreparedMutation> {
    if (!target.replaceAssetGroup) throw new UnsupportedTripleStoreCapabilityError('replaceAssetGroup', 'group-decorator');
    const prepared = await Promise.all(assets.map(async asset => {
      const [graphQuads, metadataQuads] = await Promise.all([
        this.externalizeQuads(asset.graphQuads), this.externalizeQuads(asset.metadataQuads),
      ]);
      return { ...asset, graphQuads, metadataQuads };
    }));
    return options => target.replaceAssetGroup!(prepared, options);
  }

  async prepareImmutableReplaceGraphAndSubject(target: TripleStore, graphUri: string, graphQuads: readonly Quad[],
    metaGraphUri: string, metadataSubject: string, metadataQuads: readonly Quad[]): Promise<PreparedMutation> {
    if (!target.replaceGraphAndSubject) throw new UnsupportedTripleStoreCapabilityError('replaceGraphAndSubject', 'SharedMemoryLiteralBlobStore');
    const [preparedGraph, preparedMetadata] = await Promise.all([
      this.externalizeQuads(graphQuads), this.externalizeQuads(metadataQuads),
    ]);
    return options => target.replaceGraphAndSubject!(graphUri, preparedGraph, metaGraphUri, metadataSubject, preparedMetadata, options);
  }

  async prepareImmutableReplaceSubject(target: TripleStore, graphUri: string, subject: string, quads: readonly Quad[]): Promise<PreparedMutation> {
    if (!target.replaceSubject) throw new UnsupportedTripleStoreCapabilityError('replaceSubject', 'SharedMemoryLiteralBlobStore');
    const prepared = await this.externalizeQuads(quads);
    return options => target.replaceSubject!(graphUri, subject, prepared, options);
  }

  async prepareImmutableReplaceSubjectAndInsert(target: TripleStore, graphUri: string, subject: string,
    replacementQuads: readonly Quad[], insertQuads: readonly Quad[]): Promise<PreparedMutation> {
    assertSubjectAndInsertPayload(graphUri, subject, replacementQuads, insertQuads);
    if (!target.replaceSubjectAndInsert) throw new UnsupportedTripleStoreCapabilityError('replaceSubjectAndInsert', 'SharedMemoryLiteralBlobStore');
    const prepared = await this.externalizeQuads([...replacementQuads, ...insertQuads]);
    return options => target.replaceSubjectAndInsert!(graphUri, subject, prepared.slice(0, replacementQuads.length),
      prepared.slice(replacementQuads.length), options);
  }

  async prepareImmutableAuthorCommit(target: TripleStore, input: Rfc64AuthorCommitCasInputV1): Promise<PreparedMutation<Rfc64AuthorCommitCasResultV1>> {
    if (!target.rfc64AuthorCommitCasV1) throw new UnsupportedTripleStoreCapabilityError('rfc64AuthorCommitCasV1', 'SharedMemoryLiteralBlobStore');
    // Snapshot the closed manifest synchronously, before any blob work or await.
    const manifest = normalizeRfc64AuthorCommitCasV1(input);
    const mapped = await mapRfc64AuthorCommitCasV1(manifest, {
      mapQuad: quad => this.externalizeInsertQuad(quad),
      mapObject: (object, context) => context.kind === 'expected'
        ? this.translateGuardObject(context.graphUri, object)
        : this.externalizeScalarObject(context.graphUri, object!),
    });
    const prepared = sourceFromNormalizedRfc64AuthorCommitCasV1(mapped);
    return options => target.rfc64AuthorCommitCasV1!(prepared, options);
  }

  async atomicUpdate(sparql: string, options?: UpdateOptions): Promise<void> {
    if (typeof this.inner.atomicUpdate !== 'function') {
      throw new UnsupportedTripleStoreCapabilityError('atomicUpdate', 'SharedMemoryLiteralBlobStore');
    }
    return this.inner.atomicUpdate(sparql, options);
  }

  async update(sparql: string, options?: UpdateOptions): Promise<void> {
    if (typeof this.inner.update !== 'function') {
      throw new UnsupportedTripleStoreCapabilityError('update', 'SharedMemoryLiteralBlobStore');
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
      return this.hydrateQueryResult(result, options);
    }

    const [original, placeholder] = await Promise.all([
      this.inner.query(sparql, options),
      this.inner.query(rewritten, options),
    ]);
    return this.hydrateQueryResult(mergeQueryResults(original, placeholder), options);
  }

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    return this.inner.hasGraph(graphUri, options);
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

  private async externalizeQuads(quads: readonly Quad[]): Promise<Quad[]> {
    return Promise.all(quads.map((quad) => this.externalizeInsertQuad(quad)));
  }

  private async externalizeInsertQuad(
    quad: Quad,
  ): Promise<Quad> {
    if (!shouldExternalizeLiteral(quad, this.thresholdBytes)) return quad;

    const hash = sha256Term(quad.object);
    await this.blobWrites.createOrVerify(hash, quad.object);
    return { ...quad, object: externalLiteralRefTerm(hash) };
  }

  private async translateGuardObject(
    graphUri: string,
    object: string | null,
  ): Promise<string | null> {
    if (object === null || !shouldExternalizeScalar(graphUri, object, this.thresholdBytes)) {
      return object;
    }
    const hash = sha256Term(object);
    // A guard compares caller-visible hydrated state with the physical ref.
    // Require the referenced bytes to exist before dispatching the CAS.
    await this.readBlob(hash);
    return externalLiteralRefTerm(hash);
  }

  private async externalizeScalarObject(
    graphUri: string,
    object: string,
  ): Promise<string> {
    if (!shouldExternalizeScalar(graphUri, object, this.thresholdBytes)) return object;
    const hash = sha256Term(object);
    await this.blobWrites.createOrVerify(hash, object);
    return externalLiteralRefTerm(hash);
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

  private async hydrateQueryResult(result: QueryResult, options?: QueryOptions): Promise<QueryResult> {
    if (result.type === 'boolean') return result;
    const cache = new Map<string, Promise<string>>();
    const budget = new LiteralHydrationBudget(options?.maxLiteralHydrationBytes ?? options?.maxResponseBytes);

    const map = async <T, R>(values: T[], hydrate: (value: T) => Promise<R>): Promise<R[]> => {
      if (budget.limit === undefined) return Promise.all(values.map(hydrate));
      const hydrated: R[] = [];
      for (const value of values) hydrated.push(await hydrate(value));
      return hydrated;
    };
    const term = (value: string) => this.hydrateTerm(value, cache, budget, options?.signal);
    if (result.type === 'bindings') {
      const bindings = await map(result.bindings, async row => Object.fromEntries(
        await map(Object.entries(row), async ([key, value]) => [key, await term(value)]),
      ));
      return { type: 'bindings', bindings } satisfies SelectResult;
    }
    const quads = await map(result.quads, async quad => ({ ...quad, object: await term(quad.object) }));
    return { type: 'quads', quads } satisfies ConstructResult;
  }

  private async hydrateTerm(term: string, cache: Map<string, Promise<string>>, budget: LiteralHydrationBudget, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const hash = externalLiteralRefHash(term);
    if (!hash) return budget.consume(term);
    let pending = cache.get(hash);
    if (!pending) {
      pending = this.readBlob(hash, { maxBytes: budget.remaining, signal });
      cache.set(hash, pending);
    }
    return budget.consume(await pending);
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

  private async writeBlobFile(hash: string, term: string): Promise<void> {
    await this.blobDirectory.prepare();
    const path = this.blobPath(hash);

    let file;
    try {
      file = await open(path, 'wx');
    } catch (err) {
      if (!isNodeError(err, 'EEXIST')) throw err;
      await this.readBlob(hash);
      file = await open(path, 'r+');
    }
    try {
      // Re-submit even matching existing bytes after a failed/unknown preparation.
      // Sync the writer itself: a newly opened descriptor can miss its old EIO.
      await file.writeFile(term, 'utf8');
      await file.sync();
    } finally { await file.close(); }
    await persistFileDirectoryEntries(path);
  }

  private async readBlob(hash: string, constraints?: { maxBytes?: number; signal?: AbortSignal }): Promise<string> {
    assertSha256Hex(hash);
    const path = this.blobPath(hash);
    let content: string;
    try {
      constraints?.signal?.throwIfAborted();
      content = constraints?.maxBytes === undefined
        ? await readFile(path, { encoding: 'utf8', signal: constraints?.signal })
        : await readLiteralBlobBounded(path, constraints.maxBytes, constraints.signal);
      constraints?.signal?.throwIfAborted();
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
  return shouldExternalizeScalar(quad.graph, quad.object, thresholdBytes);
}

function shouldExternalizeScalar(
  graph: string | undefined,
  object: string,
  thresholdBytes: number,
): boolean {
  return (
    isSharedMemoryGraph(graph) &&
    isSerializedLiteralObjectTerm(object) &&
    !externalLiteralRefHash(object) &&
    serializedTermByteLength(object) > thresholdBytes
  );
}

function isSharedMemoryGraph(graph: string | undefined): boolean {
  return Boolean(
    graph && (
      graph.endsWith(SHARED_MEMORY_GRAPH_SUFFIX) ||
      graph.includes(`${SHARED_MEMORY_GRAPH_SUFFIX}/`)
    ),
  );
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
