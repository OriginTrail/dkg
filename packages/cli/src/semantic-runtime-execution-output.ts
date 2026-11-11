import { createHash } from 'node:crypto';
import { DKG_RDF_LITERAL_SAFE_MUTF8_BYTES, javaModifiedUtf8ByteLength } from '@origintrail-official/dkg-core';

const SR = 'https://origintrail.io/semantic-runtime/v1#';
export const EXECUTION_OUTPUT_ENCODING = 'utf8-base64-chunks-v1';
export const EXECUTION_OUTPUT_CHUNK_BYTES = 24_000;
export const MAX_EXECUTION_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_EXECUTION_OUTPUT_BYTES / EXECUTION_OUTPUT_CHUNK_BYTES);
const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const literal = (subject: string, field: string, value: string) => ({ subject, predicate: SR + field, object: JSON.stringify(value) });
const safeLiteral = (value: string) => javaModifiedUtf8ByteLength(JSON.stringify(value)) <= DKG_RDF_LITERAL_SAFE_MUTF8_BYTES;

export class ExecutionOutputCodecError extends Error {
  constructor(readonly code: 'EXECUTION_OUTPUT_ORDER_INVALID' | 'EXECUTION_OUTPUT_ORDER_UNAVAILABLE' | 'EXECUTION_OUTPUT_CAPACITY') { super(code); }
}
function invalid(): never { throw new ExecutionOutputCodecError('EXECUTION_OUTPUT_ORDER_INVALID'); }

/** Preserve the existing representation exactly when every escaped literal fits. */
export function buildExecutionOutputQuads(executionIri: string, outputs: readonly string[]) {
  const ordered = JSON.stringify(outputs);
  if (safeLiteral(ordered) && outputs.every(safeLiteral)) {
    return [...outputs.flatMap(output => [literal(executionIri, 'output', output), literal(executionIri, 'outputHash', hash(Buffer.from(output, 'utf8')))]),
      literal(executionIri, 'orderedOutputs', ordered)];
  }
  const bytes = Buffer.from(ordered, 'utf8');
  if (bytes.byteLength > MAX_EXECUTION_OUTPUT_BYTES) throw new ExecutionOutputCodecError('EXECUTION_OUTPUT_CAPACITY');
  const count = Math.ceil(bytes.byteLength / EXECUTION_OUTPUT_CHUNK_BYTES);
  const quads = [
    ...outputs.map(output => literal(executionIri, 'outputHash', hash(Buffer.from(output, 'utf8')))),
    literal(executionIri, 'orderedOutputsEncoding', EXECUTION_OUTPUT_ENCODING),
    literal(executionIri, 'orderedOutputsByteLength', String(bytes.byteLength)),
    literal(executionIri, 'orderedOutputsSha256', hash(bytes)),
    literal(executionIri, 'orderedOutputsChunkCount', String(count)),
  ];
  for (let index = 0; index < count; index++) {
    const value = JSON.stringify({ index, data: bytes.subarray(index * EXECUTION_OUTPUT_CHUNK_BYTES, (index + 1) * EXECUTION_OUTPUT_CHUNK_BYTES).toString('base64') });
    if (!safeLiteral(value)) throw new ExecutionOutputCodecError('EXECUTION_OUTPUT_CAPACITY');
    quads.push(literal(executionIri, 'orderedOutputsChunk', value));
  }
  return quads;
}

/** Lexical RDF values already restricted to this execution and its trusted author/layer. */
export interface ExecutionOutputRow {
  g: string;
  output?: string; outputHash?: string; orderedOutputs?: string;
  orderedOutputsEncoding?: string; orderedOutputsByteLength?: string;
  orderedOutputsSha256?: string; orderedOutputsChunkCount?: string; orderedOutputsChunk?: string;
}
const CHUNK_FIELDS = ['orderedOutputsEncoding', 'orderedOutputsByteLength', 'orderedOutputsSha256', 'orderedOutputsChunkCount', 'orderedOutputsChunk'] as const;
function values(rows: readonly ExecutionOutputRow[], field: Exclude<keyof ExecutionOutputRow, 'g'>): Set<string> {
  return new Set(rows.flatMap(row => row[field] === undefined ? [] : [row[field]!]));
}
function one(rows: readonly ExecutionOutputRow[], field: Exclude<keyof ExecutionOutputRow, 'g'>): string {
  const set = values(rows, field); if (set.size !== 1) return invalid(); return [...set][0];
}
function decimal(value: string, maximum: number): number {
  if (!/^[1-9][0-9]*$/.test(value)) return invalid();
  const number = Number(value); if (!Number.isSafeInteger(number) || number > maximum) return invalid(); return number;
}
function parseOutputs(value: string): string[] {
  let outputs: unknown; try { outputs = JSON.parse(value); } catch { return invalid(); }
  if (!Array.isArray(outputs) || outputs.some(output => typeof output !== 'string')) return invalid(); return outputs as string[];
}
function same(left: Set<string>, right: Set<string>): boolean { return left.size === right.size && [...left].every(value => right.has(value)); }

/** Reconstruct one complete bounded receipt; never stitch chunks across assertion graphs. */
export function decodeExecutionOutputRows(rows: readonly ExecutionOutputRow[]): string[] {
  const chunked = rows.some(row => CHUNK_FIELDS.some(field => row[field] !== undefined));
  const ordered = values(rows, 'orderedOutputs'), legacy = values(rows, 'output');
  if (!chunked) {
    if (ordered.size > 1) return invalid();
    if (ordered.size === 1) {
      const outputs = parseOutputs([...ordered][0]); if (!same(new Set(outputs), legacy)) return invalid(); return outputs;
    }
    if (legacy.size > 1) throw new ExecutionOutputCodecError('EXECUTION_OUTPUT_ORDER_UNAVAILABLE');
    if (legacy.size === 0 && values(rows, 'outputHash').size > 0) return invalid();
    return [...legacy];
  }
  if (ordered.size || legacy.size) return invalid();
  const relevant = rows.filter(row => CHUNK_FIELDS.some(field => row[field] !== undefined) || row.outputHash !== undefined);
  if (new Set(relevant.map(row => row.g)).size !== 1) return invalid();
  if (one(relevant, 'orderedOutputsEncoding') !== EXECUTION_OUTPUT_ENCODING) return invalid();
  const byteLength = decimal(one(relevant, 'orderedOutputsByteLength'), MAX_EXECUTION_OUTPUT_BYTES);
  const count = decimal(one(relevant, 'orderedOutputsChunkCount'), MAX_CHUNKS);
  if (count !== Math.ceil(byteLength / EXECUTION_OUTPUT_CHUNK_BYTES)) return invalid();
  const expectedHash = one(relevant, 'orderedOutputsSha256'); if (!/^sha256:[a-f0-9]{64}$/.test(expectedHash)) return invalid();
  const chunkRows = relevant.filter(row => row.orderedOutputsChunk !== undefined); if (chunkRows.length !== count) return invalid();
  const chunks = new Map<number, Buffer>();
  for (const row of chunkRows) {
    const raw = row.orderedOutputsChunk!; if (raw.length > 2 * EXECUTION_OUTPUT_CHUNK_BYTES) return invalid();
    let chunk: unknown; try { chunk = JSON.parse(raw); } catch { return invalid(); }
    if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk) || Object.keys(chunk).sort().join(',') !== 'data,index') return invalid();
    const { index, data } = chunk as { index: unknown; data: unknown };
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= count || chunks.has(index as number)
      || typeof data !== 'string' || !data.length || data.length > 4 * Math.ceil(EXECUTION_OUTPUT_CHUNK_BYTES / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return invalid();
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data || bytes.byteLength !== Math.min(EXECUTION_OUTPUT_CHUNK_BYTES, byteLength - (index as number) * EXECUTION_OUTPUT_CHUNK_BYTES)) return invalid();
    chunks.set(index as number, bytes);
  }
  const bytes = Buffer.concat(Array.from({ length: count }, (_, index) => chunks.get(index)!));
  if (bytes.byteLength !== byteLength || hash(bytes) !== expectedHash) return invalid();
  const text = bytes.toString('utf8'); if (!Buffer.from(text, 'utf8').equals(bytes)) return invalid();
  const outputs = parseOutputs(text), hashes = values(relevant, 'outputHash');
  if ([...hashes].some(value => !/^sha256:[a-f0-9]{64}$/.test(value)) || !same(new Set(outputs.map(output => hash(Buffer.from(output, 'utf8')))), hashes)) return invalid();
  return outputs;
}
