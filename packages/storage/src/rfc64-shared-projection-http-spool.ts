import { createReadStream } from 'node:fs';
import {
  mkdtemp,
  open,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1,
  tripleContentV10,
  type Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';

import { parseNQuadLine } from './nquads-text.js';
import type { Quad } from './triple-store.js';

const DEFAULT_SORT_CHUNK_BYTES_V1 = 8 * 1024 * 1024;
const DEFAULT_SORT_CHUNK_LINES_V1 = 16_384;
const DEFAULT_MERGE_FAN_IN_V1 = 64;
const MAX_PENDING_LINE_CHUNKS_V1 = 256;
const MERGE_WRITE_BATCH_BYTES_V1 = 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface Rfc64SharedProjectionHttpSpoolOptionsV1 {
  readonly body: ReadableStream<Uint8Array>;
  readonly operation: Rfc64SharedProjectionStreamOperationV1;
  /** Gateway-derived lowering-only projection byte ceiling. */
  readonly byteCeiling: number;
  /** Controls HTTP consumption and spill construction. */
  readonly signal?: AbortSignal;
  /**
   * Remains live while the returned local merge stream is consumed. Adapters
   * whose store-lifecycle signal ends with the HTTP task pass the caller's
   * longer-lived gateway signal here.
   */
  readonly consumptionSignal?: AbortSignal;
  /** Test and operator isolation hook; defaults to the operating-system temp root. */
  readonly tempRoot?: string;
  /** Bounded in-memory sort run size. */
  readonly sortChunkBytes?: number;
  /** Bounds per-line object overhead for projections containing tiny triples. */
  readonly sortChunkLines?: number;
  /** Separate pre-canonicalization resource guard; not the signed output cap. */
  readonly inputLineByteCeiling?: number;
  /** Maximum sorted runs opened at once during each external-merge pass. */
  readonly mergeFanIn?: number;
}

export class Rfc64SharedProjectionHttpSpoolErrorV1 extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(`[rfc64-shared-projection-http-spool] ${message}`, options);
    this.name = 'Rfc64SharedProjectionHttpSpoolErrorV1';
  }
}

/**
 * Consume one exact-graph CONSTRUCT response with bounded memory, form sorted
 * canonical runs, and return a one-shot k-way merged quad stream.
 *
 * The HTTP body is never materialized as one string or quad array. Small
 * projections stay inside one bounded in-memory run. Larger projections spill
 * sorted canonical lines to an isolated temporary directory which is removed
 * after clean exhaustion, early return, cancellation, or failure.
 */
export async function spoolRfc64SharedProjectionHttpResponseV1(
  options: Rfc64SharedProjectionHttpSpoolOptionsV1,
): Promise<AsyncIterable<Quad>> {
  const byteCeiling = boundedPositiveInteger(
    options.byteCeiling,
    Math.min(
      options.operation.signedByteCeiling,
      options.operation.protocolByteCeiling,
    ),
    'byteCeiling',
  );
  const sortChunkBytes = boundedPositiveInteger(
    options.sortChunkBytes ?? Math.min(DEFAULT_SORT_CHUNK_BYTES_V1, byteCeiling),
    byteCeiling,
    'sortChunkBytes',
  );
  const sortChunkLines = boundedPositiveInteger(
    options.sortChunkLines ?? DEFAULT_SORT_CHUNK_LINES_V1,
    DEFAULT_SORT_CHUNK_LINES_V1,
    'sortChunkLines',
  );
  const inputLineByteCeiling = boundedPositiveInteger(
    options.inputLineByteCeiling
      ?? Math.min(
        DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1.maxLineBytes,
        options.operation.protocolByteCeiling,
      ),
    options.operation.protocolByteCeiling,
    'inputLineByteCeiling',
  );
  const mergeFanIn = boundedIntegerRange(
    options.mergeFanIn ?? DEFAULT_MERGE_FAN_IN_V1,
    2,
    DEFAULT_MERGE_FAN_IN_V1,
    'mergeFanIn',
  );
  const expectedCount = BigInt(options.operation.publicTripleCount);
  let count = 0n;
  let canonicalBytes = 0;
  let runBytes = 0;
  let run: Buffer[] = [];
  let tempDirectory: string | undefined;
  const runFiles: string[] = [];

  const spillRun = async (): Promise<void> => {
    if (run.length === 0) return;
    throwIfAborted(options.signal);
    run.sort(Buffer.compare);
    tempDirectory ??= await mkdtemp(join(options.tempRoot ?? tmpdir(), 'dkg-rfc64-projection-'));
    throwIfAborted(options.signal);
    const filePath = join(tempDirectory, `${String(runFiles.length).padStart(6, '0')}.nq`);
    await writeFile(filePath, Buffer.concat(run, runBytes), { signal: options.signal });
    runFiles.push(filePath);
    run = [];
    runBytes = 0;
  };

  try {
    for await (const rawLine of readByteLines(
      options.body,
      options.operation.protocolByteCeiling,
      inputLineByteCeiling,
      options.signal,
    )) {
      throwIfAborted(options.signal);
      const quad = parseExactConstructLine(rawLine, options.operation.graphIri);
      if (quad === null) continue;
      let content: Uint8Array;
      try {
        content = tripleContentV10(quad.subject, quad.predicate, quad.object);
      } catch (cause) {
        invalid('CONSTRUCT response contains a non-canonical RDF term', cause);
      }
      const line = Buffer.allocUnsafe(content.byteLength + 1);
      line.set(content);
      line[line.byteLength - 1] = 0x0a;
      count += 1n;
      if (count > expectedCount) {
        invalid('CONSTRUCT response exceeds the author-sealed triple count');
      }
      canonicalBytes += line.byteLength;
      if (canonicalBytes > byteCeiling) {
        invalid('CONSTRUCT response exceeds the effective projection byte ceiling');
      }
      run.push(line);
      runBytes += line.byteLength;
      if (runBytes >= sortChunkBytes || run.length >= sortChunkLines) {
        await spillRun();
      }
    }
    throwIfAborted(options.signal);
    if (count !== expectedCount) {
      invalid('CONSTRUCT response does not match the author-sealed triple count');
    }

    if (runFiles.length === 0) {
      run.sort(Buffer.compare);
      return streamMemoryRun(
        run,
        options.operation.graphIri,
        options.consumptionSignal ?? options.signal,
      );
    }
    await spillRun();
    const directory = tempDirectory;
    if (directory === undefined) invalid('temporary projection spool was not created');
    const finalRunFiles = await collapseSortedRuns(
      runFiles,
      directory,
      mergeFanIn,
      options.signal,
    );
    return mergeSortedRuns(
      finalRunFiles,
      directory,
      options.operation.graphIri,
      options.consumptionSignal ?? options.signal,
    );
  } catch (cause) {
    if (tempDirectory !== undefined) await removeTempDirectory(tempDirectory);
    throw cause;
  }
}

async function collapseSortedRuns(
  initialRunFiles: readonly string[],
  tempDirectory: string,
  mergeFanIn: number,
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  let runFiles = [...initialRunFiles];
  let pass = 0;
  while (runFiles.length > mergeFanIn) {
    const nextRunFiles: string[] = [];
    for (let offset = 0; offset < runFiles.length; offset += mergeFanIn) {
      throwIfAborted(signal);
      const batch = runFiles.slice(offset, offset + mergeFanIn);
      if (batch.length === 1) {
        nextRunFiles.push(batch[0]);
        continue;
      }
      const outputPath = join(
        tempDirectory,
        `merge-${String(pass).padStart(3, '0')}-${String(nextRunFiles.length).padStart(6, '0')}.nq`,
      );
      await writeMergedRun(batch, outputPath, signal);
      await Promise.all(batch.map((filePath) => rm(filePath, { force: true })));
      nextRunFiles.push(outputPath);
    }
    runFiles = nextRunFiles;
    pass += 1;
  }
  return runFiles;
}

async function writeMergedRun(
  runFiles: readonly string[],
  outputPath: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const output = await open(outputPath, 'wx');
  let batch: Buffer[] = [];
  let batchBytes = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    throwIfAborted(signal);
    await output.writeFile(Buffer.concat(batch, batchBytes), { signal });
    batch = [];
    batchBytes = 0;
  };
  try {
    for await (const line of mergeCanonicalFileLines(runFiles, signal)) {
      const terminated = Buffer.allocUnsafe(line.byteLength + 1);
      terminated.set(line);
      terminated[terminated.byteLength - 1] = 0x0a;
      batch.push(terminated);
      batchBytes += terminated.byteLength;
      if (batchBytes >= MERGE_WRITE_BATCH_BYTES_V1) await flush();
    }
    await flush();
  } finally {
    await output.close();
  }
}

async function* streamMemoryRun(
  lines: readonly Buffer[],
  graphIri: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<Quad, void, undefined> {
  for (const line of lines) {
    throwIfAborted(signal);
    yield parseCanonicalSpoolLine(line, graphIri);
  }
}

async function* mergeSortedRuns(
  runFiles: readonly string[],
  tempDirectory: string,
  graphIri: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<Quad, void, undefined> {
  try {
    for await (const line of mergeCanonicalFileLines(runFiles, signal)) {
      yield parseCanonicalSpoolLine(line, graphIri);
    }
  } finally {
    await removeTempDirectory(tempDirectory);
  }
}

async function* mergeCanonicalFileLines(
  runFiles: readonly string[],
  signal: AbortSignal | undefined,
): AsyncGenerator<Buffer, void, undefined> {
  const heap = new CanonicalLineHeap();
  const iterators: AsyncIterator<Buffer>[] = [];
  try {
    for (const filePath of runFiles) {
      const iterator = readCanonicalFileLines(filePath, signal)[Symbol.asyncIterator]();
      iterators.push(iterator);
      const first = await iterator.next();
      if (!first.done) heap.push({ iterator, line: first.value });
    }
    while (heap.size > 0) {
      throwIfAborted(signal);
      const entry = heap.pop();
      yield entry.line;
      const next = await entry.iterator.next();
      if (!next.done) heap.push({ iterator: entry.iterator, line: next.value });
    }
  } finally {
    await Promise.all(iterators.map(async (iterator) => iterator.return?.()));
  }
}

async function* readByteLines(
  body: ReadableStream<Uint8Array>,
  wireByteCeiling: number,
  inputLineByteCeiling: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<Buffer, void, undefined> {
  const reader = body.getReader();
  let complete = false;
  let wireBytes = 0;
  let pendingBytes = 0;
  let pending: Buffer[] = [];
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      const chunk = Buffer.from(
        next.value.buffer,
        next.value.byteOffset,
        next.value.byteLength,
      );
      wireBytes += chunk.byteLength;
      if (wireBytes > wireByteCeiling) {
        invalid('CONSTRUCT wire response exceeds the protocol hard cap');
      }
      let start = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        const suffix = chunk.subarray(start, index);
        const line = pending.length === 0
          ? suffix
          : Buffer.concat([...pending, suffix], pendingBytes + suffix.byteLength);
        if (line.byteLength > inputLineByteCeiling) {
          invalid('one CONSTRUCT response line exceeds the local input-line ceiling');
        }
        pending = [];
        pendingBytes = 0;
        start = index + 1;
        yield line;
      }
      if (start < chunk.byteLength) {
        const suffix = chunk.subarray(start);
        if (pending.length >= MAX_PENDING_LINE_CHUNKS_V1) {
          pending = [Buffer.concat(pending, pendingBytes)];
        }
        pending.push(suffix);
        pendingBytes += suffix.byteLength;
        if (pendingBytes > inputLineByteCeiling) {
          invalid('one CONSTRUCT response line exceeds the local input-line ceiling');
        }
      }
    }
    if (pendingBytes > 0) {
      yield pending.length === 1
        ? pending[0]
        : Buffer.concat(pending, pendingBytes);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function* readCanonicalFileLines(
  filePath: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<Buffer, void, undefined> {
  const stream = createReadStream(filePath, { signal });
  let pending = Buffer.alloc(0);
  try {
    for await (const rawChunk of stream) {
      throwIfAborted(signal);
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const joined = pending.byteLength === 0
        ? chunk
        : Buffer.concat([pending, chunk], pending.byteLength + chunk.byteLength);
      let start = 0;
      for (let index = 0; index < joined.byteLength; index += 1) {
        if (joined[index] !== 0x0a) continue;
        yield joined.subarray(start, index);
        start = index + 1;
      }
      pending = start < joined.byteLength ? Buffer.from(joined.subarray(start)) : Buffer.alloc(0);
    }
    if (pending.byteLength !== 0) invalid('temporary sort run is missing its final LF');
  } finally {
    stream.destroy();
  }
}

function parseExactConstructLine(line: Buffer, graphIri: string): Quad | null {
  let text: string;
  try {
    text = UTF8.decode(stripTrailingCarriageReturn(line)).trim();
  } catch (cause) {
    invalid('CONSTRUCT response is not strict UTF-8', cause);
  }
  if (text.length === 0 || text.startsWith('#')) return null;
  const quad = parseNQuadLine(text);
  if (quad === undefined) invalid('CONSTRUCT response contains a malformed N-Quads line');
  if (quad.graph !== '' && quad.graph !== graphIri) {
    invalid('CONSTRUCT response escaped the exact authenticated graph');
  }
  return Object.freeze({ ...quad, graph: graphIri });
}

function parseCanonicalSpoolLine(line: Buffer, graphIri: string): Quad {
  let text: string;
  try {
    const canonicalContent = line.byteLength > 0 && line[line.byteLength - 1] === 0x0a
      ? line.subarray(0, line.byteLength - 1)
      : line;
    text = UTF8.decode(canonicalContent);
  } catch (cause) {
    invalid('temporary sort run is not strict UTF-8', cause);
  }
  const quad = parseNQuadLine(text);
  if (quad === undefined || quad.graph !== '') {
    invalid('temporary sort run contains a malformed canonical triple');
  }
  return Object.freeze({ ...quad, graph: graphIri });
}

function stripTrailingCarriageReturn(line: Buffer): Buffer {
  return line.byteLength > 0 && line[line.byteLength - 1] === 0x0d
    ? line.subarray(0, line.byteLength - 1)
    : line;
}

interface CanonicalLineHeapEntry {
  readonly iterator: AsyncIterator<Buffer>;
  readonly line: Buffer;
}

class CanonicalLineHeap {
  private readonly entries: CanonicalLineHeapEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  push(entry: CanonicalLineHeapEntry): void {
    this.entries.push(entry);
    let index = this.entries.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (Buffer.compare(this.entries[parent].line, entry.line) <= 0) break;
      this.entries[index] = this.entries[parent];
      index = parent;
    }
    this.entries[index] = entry;
  }

  pop(): CanonicalLineHeapEntry {
    const first = this.entries[0];
    const last = this.entries.pop();
    if (first === undefined || last === undefined) invalid('temporary sort heap is empty');
    if (this.entries.length === 0) return first;
    let index = 0;
    while (true) {
      const left = (index * 2) + 1;
      if (left >= this.entries.length) break;
      const right = left + 1;
      const child = right < this.entries.length
        && Buffer.compare(this.entries[right].line, this.entries[left].line) < 0
        ? right
        : left;
      if (Buffer.compare(this.entries[child].line, last.line) >= 0) break;
      this.entries[index] = this.entries[child];
      index = child;
    }
    this.entries[index] = last;
    return first;
  }
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    invalid(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function boundedIntegerRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('RFC-64 projection spool aborted', 'AbortError');
}

async function removeTempDirectory(directory: string): Promise<void> {
  await rm(directory, { force: true, recursive: true }).catch(() => undefined);
}

function invalid(message: string, cause?: unknown): never {
  throw new Rfc64SharedProjectionHttpSpoolErrorV1(
    message,
    cause === undefined ? {} : { cause },
  );
}
