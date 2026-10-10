/** Derived entity indexes are discovery aids; the graph remains authoritative. */
export interface EntityIndexSpec {
  contextGraphId: string;
  view: 'verifiable-memory' | 'shared-working-memory';
  textPredicates: string[];
  types: string[];
}
export interface EntityDocument {
  entityUri: string;
  sourceGraph: string;
  text: string;
  contentHash: string;
}
export interface EntityEmbedder {
  readonly fingerprint: string;
  readonly dimensions: number;
  ready(signal: AbortSignal): Promise<boolean>;
  embed(text: string, kind: 'query' | 'document', signal: AbortSignal): Promise<number[]>;
}
export interface EntityEmbeddingConfig {
  provider: 'ollama';
  model: string;
  digest: string;
  dimensions: number;
  baseURL?: string;
  queryPrefix?: string;
  documentPrefix?: string;
}
export class EntitySearchError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code); }
}
export function checkDeadline(signal: AbortSignal, deadline: number): void {
  signal.throwIfAborted();
  if (performance.now() >= deadline) throw new EntitySearchError('QUERY_DEADLINE_EXCEEDED');
}
export function validVector(value: unknown, dimensions: number): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== dimensions || !value.every(v => typeof v === 'number' && Number.isFinite(v))
      || !Number.isFinite(Math.hypot(...value)) || Math.hypot(...value) === 0) throw new EntitySearchError('ENTITY_EMBEDDING_INVALID');
}

export function unitVector(value: unknown, dimensions: number): number[] {
  validVector(value, dimensions);
  const norm = Math.hypot(...value);
  return value.map(v => v / norm);
}
