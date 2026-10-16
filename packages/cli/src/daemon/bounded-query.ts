import { isPublicSnapshotMode, type PublicSnapshotMode } from '@origintrail-official/dkg-agent/public-snapshot-mode';
import { prepareSparql, prepareSparqlQuery, boundPreparedSelect } from '@origintrail-official/dkg-rdf-utils/sparql';

export const BOUNDED_QUERY_VERSION = 1;
export const BOUNDED_QUERY_MAX_ROWS = 8192;
export const BOUNDED_QUERY_MAX_BYTES = 1024 * 1024;
export const BOUNDED_QUERY_MAX_TIMEOUT_MS = 2000;
export const BOUNDED_QUERY_MAX_OFFSET = 1_000_000;

interface BoundedQueryBase {
  readonly sparql: string;
  readonly maxRows: number;
  readonly timeoutMs: number;
  readonly chainEvidenceMode?: PublicSnapshotMode;
  readonly view?: 'verifiable-memory' | 'shared-working-memory';
  readonly includeContextGraphPartitions: boolean;
}
export type BoundedQueryPolicy = BoundedQueryBase & (
  | { readonly mode: 'complete'; readonly offset: 0 }
  | { readonly mode: 'page'; readonly offset: number }
);

/** Normalize the whole request before any authority or store work starts. */
export function boundedQueryPolicy(input: Record<string, unknown>): BoundedQueryPolicy {
  const timeoutMs = input.timeoutMs ?? BOUNDED_QUERY_MAX_TIMEOUT_MS;
  const mode = input.mode ?? 'complete';
  const offset = input.offset ?? 0;
  const view = input.view;
  const chainEvidenceMode = input.chainEvidenceMode;
  if (input.version !== BOUNDED_QUERY_VERSION || typeof timeoutMs !== 'number'
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BOUNDED_QUERY_MAX_TIMEOUT_MS
      || (mode !== 'complete' && mode !== 'page') || typeof offset !== 'number'
      || !Number.isSafeInteger(offset) || offset < 0 || offset > BOUNDED_QUERY_MAX_OFFSET
      || (mode === 'complete' && offset !== 0)
      || (chainEvidenceMode !== undefined && !isPublicSnapshotMode(chainEvidenceMode))
      || (view !== undefined && view !== 'verifiable-memory' && view !== 'shared-working-memory')) {
    throw new Error('Unsupported version, view, mode, offset or deadline');
  }
  const bound = boundSelect(input.sparql, input.maxRows, mode, offset);
  const common: BoundedQueryBase = { ...bound, timeoutMs, view, chainEvidenceMode, includeContextGraphPartitions: input.includeContextGraphPartitions === true };
  return mode === 'complete' ? { ...common, mode, offset: 0 } : { ...common, mode, offset };
}

/** The extra row witnesses overflow; only the outer solution modifiers may be changed. */
export function boundSelect(sparql: unknown, maxRows: unknown, mode: 'complete' | 'page' = 'complete', offset = 0) {
  if (typeof sparql !== 'string' || Buffer.byteLength(sparql) > 64 * 1024) {
    throw new Error('Expected a SELECT query of at most 64 KiB');
  }
  if (typeof maxRows !== 'number' || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > BOUNDED_QUERY_MAX_ROWS) {
    throw new Error(`maxRows must be an integer from 1 to ${BOUNDED_QUERY_MAX_ROWS}`);
  }
  const prepared = prepareSparql(sparql);
  if (prepared.status !== 'valid') {
    throw new Error('Only read-only SELECT queries are supported');
  }
  const query = prepareSparqlQuery(prepared);
  if (query.operation !== 'SELECT') throw new Error('Only read-only SELECT queries are supported');
  if (!query.where || query.hasDatasetClause) throw new Error('A scoped WHERE clause is required');
  if (query.hasServiceClause) throw new Error('Remote SERVICE queries are not supported');
  const { hasLimit, hasOffset, hasOrderBy } = query.solutionModifiers;
  if (hasLimit || hasOffset) throw new Error('Use maxRows; top-level LIMIT and OFFSET are not supported');
  if (mode === 'page' && !hasOrderBy) throw new Error('Page mode requires a top-level ORDER BY');
  return { sparql: boundPreparedSelect(query, maxRows + 1, offset), maxRows };
}

export function boundedResult(bindings: Array<Record<string, unknown>>, maxRows: number) {
  if (bindings.length > maxRows) return { ok: false as const, code: 'QUERY_RESULT_TOO_LARGE' };
  const result = { type: 'bindings' as const, bindings };
  if (Buffer.byteLength(JSON.stringify(result)) > BOUNDED_QUERY_MAX_BYTES) {
    return { ok: false as const, code: 'QUERY_RESULT_TOO_LARGE' };
  }
  return { ok: true as const, result };
}

export type BoundedQueryResponse = {
  result: { type: 'bindings'; bindings: Array<Record<string, unknown>> };
} & (
  | { mode: 'complete'; resultComplete: true }
  | { mode: 'page'; resultComplete: false; pageComplete: true; hasMore: boolean;
      pagingLimitReached: boolean; offset: number; nextOffset: number | null }
);

export function finalizeBoundedQuery(
  policy: BoundedQueryPolicy, bindings: Array<Record<string, unknown>>,
): { ok: false; code: string } | { ok: true; response: BoundedQueryResponse } {
  const rows = policy.mode === 'page' ? bindings.slice(0, policy.maxRows) : bindings;
  const bounded = boundedResult(rows, policy.maxRows);
  if (!bounded.ok) return bounded;
  if (policy.mode === 'complete') {
    return { ok: true, response: { mode: 'complete', resultComplete: true, result: bounded.result } };
  }
  const hasMore = bindings.length > policy.maxRows;
  const nextOffset = policy.offset + rows.length;
  const canContinue = nextOffset <= BOUNDED_QUERY_MAX_OFFSET;
  return { ok: true, response: {
    mode: 'page', resultComplete: false, result: bounded.result,
    pageComplete: true, hasMore, pagingLimitReached: hasMore && !canContinue,
    offset: policy.offset, nextOffset: canContinue ? nextOffset : null,
  } };
}
