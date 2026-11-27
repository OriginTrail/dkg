import { assertSafeIri, compareCodePoint } from '@origintrail-official/dkg-core';
import type { SyncRow } from './snapshot-cache.js';

export function serializeResponderRow(row: SyncRow): string {
  return `${formatTerm(row.s)} <${assertSafeIri(row.p)}> ${formatTerm(row.o)} <${assertSafeIri(row.g)}> .`;
}

export function serializeResponderRows(rows: readonly SyncRow[]): string {
  return rows.map(serializeResponderRow).join('\n');
}

const RESPONDER_ROW_ENCODER = new TextEncoder();

/**
 * Serialized (N-Quads, UTF-8) wire byte length of one responder row — the ONE
 * byte model for response-frame budgets, shared by the byte-budget serializer
 * and the subject-atomic extend so both reason about `maxResponseBytes` the same
 * way (#1916). This is distinct from `estimateStringRowHeapBytes`, which
 * estimates retained HEAP size for snapshot memory budgets only.
 */
export function serializedResponderRowByteLength(row: SyncRow): number {
  return RESPONDER_ROW_ENCODER.encode(serializeResponderRow(row)).byteLength;
}

export function formatTerm(term: string): string {
  if (term.startsWith('"') || term.startsWith('_:')) return term;
  if (term.startsWith('<') && term.endsWith('>')) return term;
  return `<${assertSafeIri(term)}>`;
}

export function compareRows(a: SyncRow, b: SyncRow): number {
  return (
    compareCodePoint(a.g, b.g) ||
    compareCodePoint(a.s, b.s) ||
    compareCodePoint(a.p, b.p) ||
    compareCodePoint(a.o, b.o)
  );
}

/**
 * The `(g, s)` identity a durable `_meta` row belongs to. Durable meta is
 * ordered by `(g, s, p, o)`; a graph-scoped assertion seal is ONE `(g, s)`
 * subject whose rows — including the batch-local control field
 * `dkg:assertionVersion` — MUST cross the wire together in a single round, else
 * the receiver's per-round completeness check drops the control fields
 * permanently (#1788). Used to snap durable-meta page boundaries to subject
 * boundaries. The `\n` separator cannot occur inside an IRI, so distinct
 * subjects never collide.
 */
export function metaSubjectKey(row: SyncRow): string {
  return `${row.g}\n${row.s}`;
}

/**
 * Serialize the largest prefix that fits the negotiated response target.
 * Pagination advances by the number of N-Quads actually parsed by the
 * requester, so returning a prefix is cursor-safe. Always emit one row when a
 * non-empty input contains an unexpectedly oversized row; that guarantees
 * forward progress and leaves the transport's existing hard frame limit as the
 * final safety boundary for that pathological single row.
 */
export function serializeResponderRowsWithinByteBudget(
  rows: readonly SyncRow[],
  maxBytes: number,
): string {
  const safeMaxBytes = Math.max(1, Math.floor(maxBytes));
  const page: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const serialized = serializeResponderRow(row);
    const rowBytes = serializedResponderRowByteLength(row) + (page.length > 0 ? 1 : 0);
    if (page.length > 0 && bytes + rowBytes > safeMaxBytes) break;
    page.push(serialized);
    bytes += rowBytes;
    if (bytes >= safeMaxBytes) break;
  }
  return page.join('\n');
}
