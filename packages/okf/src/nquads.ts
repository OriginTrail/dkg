/**
 * Deterministic N-Quads serialization for golden tests and `export`.
 *
 * Quad object terms already use the node's quad encoding (raw IRIs without
 * angle brackets, literals as `"…"` / `"…"^^<dt>`, blanks as `_:…`). This
 * renders them as canonical N-Quads: IRIs wrapped in `<…>`, literals/blanks
 * passed through, then deduplicated and lexically sorted so the same graph
 * always serialises to byte-identical output.
 */

import type { Quad } from './types.js';

function termToNQuads(term: string): string {
  if (term.startsWith('_:')) return term; // blank node
  if (term.startsWith('"')) return term; // literal (possibly `"…"^^<dt>` / `"…"@lang`)
  return `<${term}>`; // IRI
}

/** Render quads to canonical (deduped + sorted) N-Quads. */
export function quadsToNQuads(quads: Quad[]): string {
  const lines = quads.map((q) => {
    const graph = q.graph ? ` ${termToNQuads(q.graph)}` : '';
    return `${termToNQuads(q.subject)} <${q.predicate}> ${termToNQuads(q.object)}${graph} .`;
  });
  const unique = [...new Set(lines)].sort();
  return unique.length > 0 ? unique.join('\n') + '\n' : '';
}
