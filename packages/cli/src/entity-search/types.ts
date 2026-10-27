import type { PublicSnapshotMode } from '@origintrail-official/dkg-agent/public-snapshot-mode';
/** Derived entity indexes are discovery aids; the graph remains authoritative. */
export interface EntityIndexSpec {
  contextGraphId: string;
  view: 'verifiable-memory' | 'shared-working-memory';
  textPredicates: string[];
  types: string[];
}
interface EntityReadPolicy { chainEvidenceMode?: PublicSnapshotMode }
export type EntityReadSpec = EntityIndexSpec & EntityReadPolicy;
export interface EntityIndexRequest extends EntityIndexSpec, EntityReadPolicy { restart?: boolean; timeoutMs?: number }
export interface EntityReadinessRequest extends EntityReadPolicy { contextGraphId: string; indexId: string; warmup?: boolean; timeoutMs?: number }
export interface EntitySearchRequest extends EntityReadPolicy { contextGraphId: string; indexId: string; query: string; limit?: number; timeoutMs?: number }
export type NormalizedIndexRequest = EntityIndexSpec & Required<EntityReadPolicy> & { restart: boolean; timeoutMs: number };
export type NormalizedReadinessRequest = Required<EntityReadinessRequest>;
export type NormalizedSearchRequest = Required<EntitySearchRequest>;
export type EntityOperation =
  | { kind: 'index'; request: NormalizedIndexRequest }
  | { kind: 'readiness'; request: NormalizedReadinessRequest }
  | { kind: 'search'; request: NormalizedSearchRequest };
export interface EntityIdentity {
  entityUri: string;
  sourceGraph: string;
}
export interface EntityDocument extends EntityIdentity {
  text: string;
  contentHash: string;
}
/** Persist only candidate metadata; authorized graph reads supply response text. */
export interface EntityCandidate extends EntityIdentity {
  contentHash: string;
  vector: number[];
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

export interface EntityIndexStatus {
  indexId: string;
  contextGraphId: string;
  view: EntityIndexSpec['view'];
  modelFingerprint: string;
  indexedEntities: number;
  scanComplete: boolean;
  completedAt: string | null;
  coverage: 'local-indexed-subset';
  graphComplete: null;
}
export interface EntityReadinessResponse extends EntityIndexStatus {
  ready: boolean;
  observedAt: string;
}
export interface EntitySearchResponse extends EntityIndexStatus {
  entities: Array<EntityDocument & { score: number }>;
  staleCandidates: number;
  observedAt: string;
  freshness: 'candidates-revalidated';
  exhaustive: false;
}
