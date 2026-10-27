/**
 * Query Cost Schedule v1 — the tokenizer pin applied to SPARQL (port of the
 * fork's `subs/query-cost.ts`). The schedule is a content-addressed document
 * both seats hold; every term is computable from the query bytes and the
 * delivered result, never from execution work.
 *
 * Split decrement: `admission` (base + static complexity) is owed once a
 * query is admitted; `delivery` (rows / rowsPerDeliveryUnit, ceil) only when
 * a result is delivered. A guard-aborted query keeps its admission cost.
 *
 * The schedule is integer-only (`rowsPerDeliveryUnit: 100` replaces the
 * fork's `perReturnedResult: 0.01`), hence its own version string and digest.
 *
 * `analyzeQuery` is VERBATIM: its approximations are part of the schedule,
 * so do not "fix" them. It is quadratic on adversarial input, so every
 * function that analyses a query first refuses anything above
 * `QUERY_MAX_SPARQL_BYTES` (a wire limit, not a schedule term).
 */
import { sha256Digest } from './token-engines.js';

export interface QueryCostSchedule {
  readonly version: 'dkg-mkt-query-cost/1';
  readonly base: number;
  readonly perTriplePattern: number;
  /** Distinct variables appearing in more than one pattern line. */
  readonly perJoinVar: number;
  readonly perPropertyPath: number;
  readonly perOptionalOrUnion: number;
  readonly perFilter: number;
  readonly perAggregation: number;
  readonly missingLimitSurcharge: number;
  /** Delivery term: one unit per this many returned rows (ceil). */
  readonly rowsPerDeliveryUnit: number;
}

export const QUERY_COST_SCHEDULE_V1: QueryCostSchedule = Object.freeze({
  version: 'dkg-mkt-query-cost/1',
  base: 2,
  perTriplePattern: 1,
  perJoinVar: 2,
  perPropertyPath: 3,
  perOptionalOrUnion: 3,
  perFilter: 1,
  perAggregation: 5,
  missingLimitSurcharge: 10,
  rowsPerDeliveryUnit: 100,
});

/** Content address: sha256 of `JSON.stringify` with keys sorted. */
export function queryCostScheduleDigest(s: QueryCostSchedule): string {
  const record = s as unknown as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) canonical[key] = record[key];
  return sha256Digest(JSON.stringify(canonical));
}

export const QUERY_COST_SCHEDULE_V1_DIGEST = queryCostScheduleDigest(QUERY_COST_SCHEDULE_V1);

export interface QueryGuards {
  timeoutMs: number;
  maxRows: number;
}

/** Seller execution guards; an abort keeps the admission cost only. */
export const DEFAULT_QUERY_GUARDS: QueryGuards = Object.freeze({ timeoutMs: 10_000, maxRows: 10_000 });

/** Maximum SPARQL size (UTF-8 bytes) either seat analyses. */
export const QUERY_MAX_SPARQL_BYTES = 8192 as const;

export class QueryTooLargeError extends Error {
  override readonly name = 'QueryTooLargeError' as const;
  constructor(readonly bytes: number) {
    super(`SPARQL is ${bytes} bytes; the marketplace limit is ${QUERY_MAX_SPARQL_BYTES}`);
  }
}

/** Throws `QueryTooLargeError` when `utf8Bytes(sparql) > QUERY_MAX_SPARQL_BYTES` — before any regex runs. */
export function assertQueryWithinLimit(sparql: string): void {
  if (typeof sparql !== 'string') throw new TypeError('sparql must be a string');
  // UTF-8 never has fewer bytes than UTF-16 code units, so long strings fail fast.
  if (sparql.length > QUERY_MAX_SPARQL_BYTES || Buffer.byteLength(sparql, 'utf8') > QUERY_MAX_SPARQL_BYTES) {
    throw new QueryTooLargeError(Buffer.byteLength(sparql, 'utf8'));
  }
}

export interface QueryComplexity {
  triplePatterns: number;
  joinVars: number;
  propertyPaths: number;
  optionalsAndUnions: number;
  filters: number;
  aggregations: number;
  hasLimit: boolean;
}

/**
 * A deliberately static analyzer (verbatim fork): counts syntactic features
 * only. Both seats run the same function over the same bytes and must agree.
 */
export function analyzeQuery(sparql: string): QueryComplexity {
  assertQueryWithinLimit(sparql);
  // strip string literals and IRIs so their contents can't confuse counting
  const stripped = sparql
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/<[^>\s]*>/g, '<iri>')
    .replace(/#[^\n]*/g, '');

  const optionals = (stripped.match(/\bOPTIONAL\b/gi) ?? []).length;
  const unions = (stripped.match(/\bUNION\b/gi) ?? []).length;
  const filters = (stripped.match(/\bFILTER\b/gi) ?? []).length;
  const aggregations =
    (stripped.match(/\b(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|SAMPLE)\s*\(/gi) ?? []).length +
    (stripped.match(/\bGROUP\s+BY\b/gi) ?? []).length;
  const hasLimit = /\bLIMIT\s+\d+/i.test(stripped);

  // property paths: sequence/alternative/closure operators between terms
  const propertyPaths =
    (stripped.match(/[)\w>](\s*[/|]\s*|\s*)[*+?]?(?=\s*[\w<?])/g) ?? []).filter((m) => /[/|*+]/.test(m)).length +
    (stripped.match(/\w\*|\w\+(?!\d)/g) ?? []).filter((m) => /[*+]$/.test(m)).length;

  // triple patterns: approximate as dot-terminated statements inside braces
  const body = stripped.slice(stripped.indexOf('{'), stripped.lastIndexOf('}') + 1);
  const triplePatterns = (body.match(/[^.{}\s][^.{}]*\./g) ?? []).length || (body.trim() ? 1 : 0);

  // join variables: ?vars that appear in more than one pattern line
  const varCounts = new Map<string, number>();
  for (const line of body.split(/[.;{}]/)) {
    const seen = new Set([...line.matchAll(/[?$][A-Za-z_]\w*/g)].map((m) => m[0]));
    for (const v of seen) varCounts.set(v, (varCounts.get(v) ?? 0) + 1);
  }
  const joinVars = [...varCounts.values()].filter((n) => n > 1).length;

  return {
    triplePatterns,
    joinVars,
    propertyPaths,
    optionalsAndUnions: optionals + unions,
    filters,
    aggregations,
    hasLimit,
  };
}

const SCHEDULE_TERMS = [
  'base',
  'perTriplePattern',
  'perJoinVar',
  'perPropertyPath',
  'perOptionalOrUnion',
  'perFilter',
  'perAggregation',
  'missingLimitSurcharge',
] as const;

function termOf(s: QueryCostSchedule, key: (typeof SCHEDULE_TERMS)[number] | 'rowsPerDeliveryUnit'): bigint {
  const value = s[key];
  if (!Number.isSafeInteger(value) || value < 0 || (key === 'rowsPerDeliveryUnit' && value < 1)) {
    throw new Error(`query cost schedule term ${key} must be a non-negative integer (rowsPerDeliveryUnit ≥ 1)`);
  }
  return BigInt(value);
}

function toRows(rows: bigint | number): bigint {
  if (typeof rows === 'number' && !Number.isSafeInteger(rows)) throw new Error(`rows must be an integer, got: ${rows}`);
  const value = BigInt(rows);
  if (value < 0n) throw new Error(`rows must be non-negative, got: ${value}`);
  return value;
}

/** Admission units: base + static complexity (all integer terms). */
export function queryAdmissionUnits(sparql: string, s: QueryCostSchedule = QUERY_COST_SCHEDULE_V1): bigint {
  const c = analyzeQuery(sparql);
  return (
    termOf(s, 'base') +
    BigInt(c.triplePatterns) * termOf(s, 'perTriplePattern') +
    BigInt(c.joinVars) * termOf(s, 'perJoinVar') +
    BigInt(c.propertyPaths) * termOf(s, 'perPropertyPath') +
    BigInt(c.optionalsAndUnions) * termOf(s, 'perOptionalOrUnion') +
    BigInt(c.filters) * termOf(s, 'perFilter') +
    BigInt(c.aggregations) * termOf(s, 'perAggregation') +
    (c.hasLimit ? 0n : termOf(s, 'missingLimitSurcharge'))
  );
}

/** Delivery units: `ceil(rows / rowsPerDeliveryUnit)`. */
export function queryDeliveryUnits(rows: bigint | number, s: QueryCostSchedule = QUERY_COST_SCHEDULE_V1): bigint {
  const value = toRows(rows);
  const per = termOf(s, 'rowsPerDeliveryUnit');
  return (value + per - 1n) / per;
}

/** Worst case for sizing an authorization: admission + delivery(maxRows). */
export function queryWorstCaseUnits(
  sparql: string,
  maxRows: bigint | number,
  s: QueryCostSchedule = QUERY_COST_SCHEDULE_V1,
): bigint {
  return queryAdmissionUnits(sparql, s) + queryDeliveryUnits(maxRows, s);
}

/**
 * Seller admission against an authorization: refuse when `maxUnits` cannot
 * cover admission; otherwise the row cap the delivery may not exceed,
 * `min(guardMaxRows, (maxUnits − admission) · rowsPerDeliveryUnit)`.
 */
export function queryRowCap(
  sparql: string,
  maxUnits: bigint,
  guardMaxRows: bigint | number,
  s: QueryCostSchedule = QUERY_COST_SCHEDULE_V1,
): { admit: false } | { admit: true; admissionUnits: bigint; rowCap: bigint } {
  const admissionUnits = queryAdmissionUnits(sparql, s);
  if (maxUnits < admissionUnits) return { admit: false };
  const guardRows = toRows(guardMaxRows);
  const affordable = (maxUnits - admissionUnits) * termOf(s, 'rowsPerDeliveryUnit');
  return { admit: true, admissionUnits, rowCap: affordable < guardRows ? affordable : guardRows };
}

/** Rows of a delivered result: `bindings.length + quads.length` (arrays only). */
export function countResultRows(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const record = result as { bindings?: unknown; quads?: unknown };
  return (
    (Array.isArray(record.bindings) ? record.bindings.length : 0) + (Array.isArray(record.quads) ? record.quads.length : 0)
  );
}
