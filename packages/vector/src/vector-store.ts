const SKOLEM_PREFIX = '/.well-known/genid/';

export interface VectorEntry {
  id?: number;
  subject: string;
  predicate: string;
  object: string;
  graph: string;
  paranetId: string;
  text: string;
  embedding: number[];
  createdAt: number;
}

export interface VectorSearchResult {
  entry: Omit<VectorEntry, 'embedding'>;
  score: number;
}

export interface VectorStoreSearchOptions {
  topK?: number;
  paranetId?: string;
  graph?: string;
  minScore?: number;
}

export interface VectorStoreCountOptions {
  paranetId?: string;
  graph?: string;
}

export interface VectorStoreDeleteRootOptions {
  paranetId?: string;
  graph?: string;
}

export interface VectorStoreConfig {
  dataDir: string;
  dimensions: number;
}

export interface VectorStore {
  upsert(entries: VectorEntry[]): Promise<void>;
  search(embedding: number[], opts?: VectorStoreSearchOptions): Promise<VectorSearchResult[]>;
  delete(ids: number[]): Promise<void>;
  deleteByGraph(graph: string): Promise<number>;
  deleteByParanet(paranetId: string): Promise<number>;
  deleteByRootEntity(rootEntity: string, opts?: VectorStoreDeleteRootOptions): Promise<number>;
  count(opts?: VectorStoreCountOptions): Promise<number>;
  close(): Promise<void>;
}

export function encodeEmbedding(embedding: number[]): Buffer {
  const floats = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    floats[i] = embedding[i] ?? 0;
  }
  return Buffer.from(floats.buffer);
}

export function decodeEmbedding(blob: Buffer | Uint8Array): number[] {
  const buffer = Buffer.isBuffer(blob)
    ? blob
    : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const view = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
  return Array.from(view);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < length; i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function normalizeEmbedding(embedding: number[], dimensions?: number): number[] {
  const vector = dimensions !== undefined
    ? Array.from({ length: dimensions }, (_, index) => embedding[index] ?? 0)
    : [...embedding];
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  if (norm === 0) return vector;
  const magnitude = Math.sqrt(norm);
  return vector.map((value) => value / magnitude);
}

export function isSkolemizedDescendant(subject: string, rootEntity: string): boolean {
  return subject.startsWith(`${rootEntity}${SKOLEM_PREFIX}`);
}

export function scoreToDistance(score: number): number {
  return 1 - score;
}

export function rowToSearchResult(
  row: {
    id: number;
    subject: string;
    predicate: string;
    object: string;
    graph: string;
    paranet_id: string;
    text: string;
    created_at: number;
  },
  score: number,
): VectorSearchResult {
  return {
    entry: {
      id: row.id,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      graph: row.graph,
      paranetId: row.paranet_id,
      text: row.text,
      createdAt: row.created_at,
    },
    score,
  };
}
