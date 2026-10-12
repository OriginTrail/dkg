// SPDX-License-Identifier: Apache-2.0
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
