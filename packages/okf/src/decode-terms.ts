/**
 * RDF object term → YAML value, for export. Shared by the exporter's base
 * fields (`export.ts`) and the family decoder (`families/decode.ts`).
 */

import { RDF_JSON, XSD_BOOLEAN, XSD_DECIMAL, XSD_INTEGER } from './constants.js';
import { hasOwn, setOwn } from './utils.js';

const LITERAL_RE = /^("(?:\\.|[^"\\])*")(?:\^\^<[^>]*>|@[A-Za-z-]+)?$/;
const TYPED_LITERAL_RE = /^("(?:\\.|[^"\\])*")\^\^<([^>]*)>$/;
const NODE_INDEX_RE = /_(\d+)$/;

/** What one export run knows: the IRI namespace and the exact set of concept IRIs being written. */
export interface ExportContext {
  iriBase: string;
  /** Subject IRIs of the concepts in this export — the only IRIs a path-valued field may be rewritten to a path for. */
  conceptIris: ReadonlySet<string>;
}

/** Lexical value of a literal term, or `null` if the term is an IRI / blank node. */
export function literalValue(term: string): string | null {
  if (!term.startsWith('"')) return null;
  const m = term.match(LITERAL_RE);
  if (!m) return null;
  return JSON.parse(m[1]) as string;
}

/**
 * Recover the native value of a known typed literal so producer-defined
 * numeric / boolean / object keys survive the round-trip. Import maps `count: 3`
 * → `"3"^^xsd:integer` and `{a: 1}` → `"{\"a\":1}"^^rdf:JSON`; without this,
 * export would emit YAML strings, which re-import as plain literals (datatype
 * and structure lost). Returns `null` for unknown datatypes / plain literals
 * so callers fall back to the lexical string.
 */
function typedValue(term: string): { value: unknown } | null {
  const m = term.match(TYPED_LITERAL_RE);
  if (!m) return null;
  const lexical = JSON.parse(m[1]) as string;
  switch (m[2]) {
    case XSD_INTEGER: {
      const n = Number(lexical);
      return Number.isInteger(n) ? { value: n } : null;
    }
    case XSD_DECIMAL: {
      const n = Number(lexical);
      return Number.isFinite(n) ? { value: n } : null;
    }
    case XSD_BOOLEAN:
      return lexical === 'true' ? { value: true } : lexical === 'false' ? { value: false } : null;
    case RDF_JSON: {
      try {
        return { value: JSON.parse(lexical) as unknown };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

export function conceptIdFromIri(iri: string, iriBase: string): string | null {
  return iri.startsWith(iriBase) ? iri.slice(iriBase.length) : null;
}

/**
 * Object term → YAML value. Literals become their typed native value or lexical
 * string; IRIs are written as given, except that for path-valued fields
 * (`pathForm`) an IRI that is one of the exported concepts is written back as
 * its recommended absolute bundle path `/<conceptId>.md` (SPEC §6.1/§6.2).
 * Membership is checked against the exported concept set, not just the IRI
 * namespace: with `iriBase: "https://example.org/"` an external
 * `https://example.org/docs/external` source must survive verbatim, or
 * re-import would read a broken path and lose its `prov:wasDerivedFrom` edge.
 */
export function termValue(term: string, ctx: ExportContext, pathForm = false): unknown {
  if (term.startsWith('"')) {
    const typed = typedValue(term);
    return typed ? typed.value : (literalValue(term) ?? term);
  }
  if (pathForm && ctx.conceptIris.has(term)) {
    const id = conceptIdFromIri(term, ctx.iriBase);
    if (id !== null) return `/${id}.md`;
  }
  return term;
}

/**
 * Accumulate a (possibly multi-valued) key: scalar on first sight, list
 * thereafter. Own-property checks and writes, so producer keys named
 * `constructor`, `toString` or `__proto__` are stored like any other.
 */
export function accumulate(target: Record<string, unknown>, key: string, value: unknown): void {
  if (hasOwn(target, key)) {
    const cur = target[key];
    setOwn(target, key, Array.isArray(cur) ? [...cur, value] : [cur, value]);
  } else {
    setOwn(target, key, value);
  }
}

/** Entry order baked into a family node IRI (`…_<n>`); unknown → last. */
function nodeIndex(iri: string): number {
  const m = iri.match(NODE_INDEX_RE);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** Sort family node IRIs back into frontmatter entry order. */
export function byNodeIndex(a: string, b: string): number {
  return nodeIndex(a) - nodeIndex(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Place `known` keys first (in the given order), then everything else in insertion order. */
export function orderKeys(obj: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of known) if (hasOwn(obj, k)) setOwn(out, k, obj[k]);
  for (const k of Object.keys(obj)) if (!hasOwn(out, k)) setOwn(out, k, obj[k]);
  return out;
}
