// SPDX-License-Identifier: Apache-2.0
import type { QueryOptions, UpdateOptions } from './triple-store.js';
import type { ChangeRecord } from './changelog-store.js';
/** Extract an integer from a binding term (`"42"^^<…integer>`, `42`, or `"42"`). */
export function parseIntTerm(term: string | undefined): number | null {
  if (term == null) return null;
  const m = term.match(/-?\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** Bare IRI from a binding term (strip surrounding angle brackets if present). */
export function stripIri(term: string | undefined): string {
  if (!term) return '';
  return term.startsWith('<') && term.endsWith('>') ? term.slice(1, -1) : term;
}

/** Lexical value from a literal binding term (`"upsert"` → `upsert`). */
export function stripLiteral(term: string | undefined): string {
  if (!term) return '';
  const m = term.match(/^"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : term;
}

/**
 * Distinct seqs one page covers — the load-bearing count behind
 * {@link ChangelogStore.readChanges}. A page keeps widening until it covers
 * `limit` distinct seqs or the log is drained, because the responder reads a
 * page shorter than `limit` as "log drained" and advances the requester past
 * everything it did not receive. Duplicate rows for one seq (two writers across
 * a release swap) count once; a missing seq (a hole) is what the next window
 * makes up for. Never relax this to the row count.
 */
export function distinctSeqCoverage(page: readonly ChangeRecord[]): number {
  return new Set(page.map((record) => record.seq)).size;
}

/** Append well-formed `{ seq, graph, op }` rows from a SELECT binding set, skipping malformed rows. */
export function collectChangeRecords(
  bindings: ReadonlyArray<Record<string, string | undefined>>,
  out: ChangeRecord[],
): void {
  for (const b of bindings) {
    const seq = parseIntTerm(b.seq);
    const graph = stripIri(b.graph);
    const op = stripLiteral(b.op);
    if (seq == null || !graph || (op !== 'upsert' && op !== 'drop')) continue;
    out.push({ seq, graph, op });
  }
}

/**
 * Drop the update-only `touchedGraphs` hint, yielding the read-path
 * `QueryOptions` (source/priority/signal) to forward to the post-mutation
 * `hasGraph` probes. Intentionally duplicates GraphSetIndexStore's boundary
 * helper of the same name — a trivial destructure kept local to avoid a
 * decorator-to-decorator import.
 */
export function queryOptionsFromUpdateOptions(options?: UpdateOptions): QueryOptions | undefined {
  if (!options) return undefined;
  const { touchedGraphs: _touchedGraphs, ...readOptions } = options;
  return readOptions;
}
