import { assertSafeIri } from '@origintrail-official/dkg-core';
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
