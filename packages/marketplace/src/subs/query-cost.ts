// Query Cost Schedule v1 — the tokenizer-bundle move applied to queries.
// The schedule is a content-addressed document both seats hold; every term
// is computable from bytes both hold. Execution-dependent cost (scanned
// work) is NEVER billed — sellers cover its residual via the base term,
// their per-unit ask, and execution guards.
//
// Decrement semantics: base + static complexity on ADMISSION; per-returned-
// result weight on DELIVERY. A guard-aborted query keeps its admission cost
// and bills nothing further.

import { createHash } from "node:crypto";

export interface QueryCostSchedule {
  version: "nsm-query-cost/1";
  base: number;                       // units, every admitted query
  perTriplePattern: number;
  perJoinVar: number;                 // distinct variables appearing in >1 pattern
  perPropertyPath: number;
  perOptionalOrUnion: number;
  perFilter: number;
  perAggregation: number;
  missingLimitSurcharge: number;
  perReturnedResult: number;          // delivery term, per solution row
}

export const SCHEDULE_V1: QueryCostSchedule = {
  version: "nsm-query-cost/1",
  base: 2,
  perTriplePattern: 1,
  perJoinVar: 2,
  perPropertyPath: 3,
  perOptionalOrUnion: 3,
  perFilter: 1,
  perAggregation: 5,
  missingLimitSurcharge: 10,
  perReturnedResult: 0.01,            // 1 unit per 100 returned rows
};

/** Canonical bytes → content address. The offer KA pins this digest; drift
 *  between seats is a statement dispute, exactly like tokenizer drift. */
export function scheduleDigest(s: QueryCostSchedule): string {
  const canonical = JSON.stringify(Object.keys(s).sort().reduce((o, k) => {
    (o as Record<string, unknown>)[k] = (s as unknown as Record<string, unknown>)[k]; return o;
  }, {} as Record<string, unknown>));
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

// ── static SPARQL complexity — computed from the identical query bytes ─────

export interface QueryComplexity {
  triplePatterns: number;
  joinVars: number;
  propertyPaths: number;
  optionalsAndUnions: number;
  filters: number;
  aggregations: number;
  hasLimit: boolean;
}

/** A deliberately static analyzer: counts syntactic features only. Both
 *  seats run the same function over the same bytes and must agree — no
 *  cost model of execution, no cardinality estimation, ever. */
export function analyzeQuery(sparql: string): QueryComplexity {
  // strip string literals and IRIs so their contents can't confuse counting
  const stripped = sparql
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/<[^>\s]*>/g, "<iri>")
    .replace(/#[^\n]*/g, "");

  const optionals = (stripped.match(/\bOPTIONAL\b/gi) ?? []).length;
  const unions = (stripped.match(/\bUNION\b/gi) ?? []).length;
  const filters = (stripped.match(/\bFILTER\b/gi) ?? []).length;
  const aggregations = (stripped.match(/\b(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|SAMPLE)\s*\(/gi) ?? []).length
                     + (stripped.match(/\bGROUP\s+BY\b/gi) ?? []).length;
  const hasLimit = /\bLIMIT\s+\d+/i.test(stripped);

  // property paths: sequence/alternative/closure operators between terms
  const propertyPaths = (stripped.match(/[)\w>](\s*[/|]\s*|\s*)[*+?]?(?=\s*[\w<?])/g) ?? [])
    .filter((m) => /[/|*+]/.test(m)).length
    + (stripped.match(/\w\*|\w\+(?!\d)/g) ?? []).filter((m) => /[*+]$/.test(m)).length;

  // triple patterns: approximate as dot-terminated statements inside braces
  const body = stripped.slice(stripped.indexOf("{"), stripped.lastIndexOf("}") + 1);
  const triplePatterns = (body.match(/[^.{}\s][^.{}]*\./g) ?? []).length || (body.trim() ? 1 : 0);

  // join variables: ?vars that appear in more than one pattern line
  const varCounts = new Map<string, number>();
  for (const line of body.split(/[.;{}]/)) {
    const seen = new Set([...line.matchAll(/[?$][A-Za-z_]\w*/g)].map((m) => m[0]));
    for (const v of seen) varCounts.set(v, (varCounts.get(v) ?? 0) + 1);
  }
  const joinVars = [...varCounts.values()].filter((n) => n > 1).length;

  return { triplePatterns, joinVars, propertyPaths, optionalsAndUnions: optionals + unions, filters, aggregations, hasLimit };
}

/** Admission units: base + static complexity — decremented on submit. */
export function admissionUnits(sparql: string, s: QueryCostSchedule = SCHEDULE_V1): number {
  const c = analyzeQuery(sparql);
  return Math.ceil(
    s.base +
    c.triplePatterns * s.perTriplePattern +
    c.joinVars * s.perJoinVar +
    c.propertyPaths * s.perPropertyPath +
    c.optionalsAndUnions * s.perOptionalOrUnion +
    c.filters * s.perFilter +
    c.aggregations * s.perAggregation +
    (c.hasLimit ? 0 : s.missingLimitSurcharge));
}

/** Delivery units: per-returned-result weight — decremented on delivery.
 *  A guard-aborted query never reaches this. */
export function deliveryUnits(returnedRows: number, s: QueryCostSchedule = SCHEDULE_V1): number {
  return Math.ceil(returnedRows * s.perReturnedResult);
}

// ── execution guards (seller-side; abort keeps admission cost only) ────────

export interface QueryGuards { timeoutMs: number; maxRows: number; scanBudget: number }
export const DEFAULT_GUARDS: QueryGuards = { timeoutMs: 10_000, maxRows: 10_000, scanBudget: 1_000_000 };

export type GuardOutcome =
  | { kind: "delivered"; rows: number }
  | { kind: "aborted"; reason: "timeout" | "scan-budget" | "row-cap" };

/** Billing consequence of an outcome under the split-decrement rule. */
export function unitsForOutcome(sparql: string, outcome: GuardOutcome, s: QueryCostSchedule = SCHEDULE_V1): {
  admission: number; delivery: number; total: number;
} {
  const admission = admissionUnits(sparql, s);
  const delivery = outcome.kind === "delivered" ? deliveryUnits(outcome.rows, s) : 0;
  return { admission, delivery, total: admission + delivery };
}
