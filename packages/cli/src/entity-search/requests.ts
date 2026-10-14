import { isPublicSnapshotMode, type PublicSnapshotMode } from '@origintrail-official/dkg-agent/public-snapshot-mode';
import { parseSpec } from './documents.js';
import { EntitySearchError, type EntityOperation, type NormalizedIndexRequest,
  type NormalizedReadinessRequest, type NormalizedSearchRequest } from './types.js';

function invalid(): never { throw new EntitySearchError('ENTITY_INVALID_REQUEST', 400); }
function body(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const value = raw as Record<string, unknown>;
  if (typeof value.contextGraphId !== 'string' || !value.contextGraphId
    || (value.warmup !== undefined && typeof value.warmup !== 'boolean')
    || (value.restart !== undefined && typeof value.restart !== 'boolean')) return invalid();
  return value;
}
function evidenceMode(value: Record<string, unknown>): PublicSnapshotMode {
  if (value.chainEvidenceMode === undefined) return 'rpc-only';
  if (!isPublicSnapshotMode(value.chainEvidenceMode)) return invalid();
  return value.chainEvidenceMode;
}
function timeout(value: Record<string, unknown>, preparation: boolean): number {
  const ms = value.timeoutMs ?? (preparation ? 30_000 : 2_000);
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 1 || ms > (preparation ? 30_000 : 5_000)) return invalid();
  return ms;
}
function identity(value: Record<string, unknown>): { contextGraphId: string; indexId: string } {
  if (typeof value.indexId !== 'string' || !/^[a-f0-9]{64}$/.test(value.indexId)
    || typeof value.contextGraphId !== 'string') return invalid();
  return { contextGraphId: value.contextGraphId, indexId: value.indexId };
}
export function parseIndexRequest(raw: unknown): NormalizedIndexRequest {
  const value = body(raw);
  return { ...parseSpec(value), chainEvidenceMode: evidenceMode(value), restart: value.restart === true, timeoutMs: timeout(value, true) };
}
export function parseReadinessRequest(raw: unknown): NormalizedReadinessRequest {
  const value = body(raw);
  return { ...identity(value), chainEvidenceMode: evidenceMode(value), warmup: value.warmup === true, timeoutMs: timeout(value, value.warmup === true) };
}
export function parseSearchRequest(raw: unknown): NormalizedSearchRequest {
  const value = body(raw), limit = value.limit ?? 5;
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 6000
    || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) return invalid();
  return { ...identity(value), chainEvidenceMode: evidenceMode(value), query: value.query, limit, timeoutMs: timeout(value, false) };
}
export function parseEntityOperation(kind: EntityOperation['kind'], raw: unknown): EntityOperation {
  switch (kind) {
    case 'index': return { kind, request: parseIndexRequest(raw) };
    case 'readiness': return { kind, request: parseReadinessRequest(raw) };
    case 'search': return { kind, request: parseSearchRequest(raw) };
  }
}
