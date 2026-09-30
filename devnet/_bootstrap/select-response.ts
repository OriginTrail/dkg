/**
 * A SPARQL SELECT answer from a DKG daemon's /api/query, as the devnet harness reads it:
 * the shape of one binding cell and the functions that turn a cell into a term string.
 * This is the one place that knows what a cell looks like; `harness.ts` re-exports
 * everything below, so suites keep importing it from there.
 *
 * Kept free of the harness's own imports (ethers, the chain helpers) so that a suite's
 * no-devnet unit tests can load it.
 */

/**
 * A single SPARQL result binding cell from the DKG daemon's /api/query. It arrives
 * either as an already-formatted N-Triples term STRING (`"v"@en`, `"v"^^<dt>`,
 * `<iri>`, `_:b`) or as a structured SPARQL-JSON object. Suites must NOT re-hedge
 * this union inline — route every cell through `normTerm` / `valueOf` / `lexical` /
 * `unwrapIri` below (the single typed boundary, per otReviewAgent #1397).
 */
export type SparqlBindingCell =
  | string
  | {
      value?: string;
      datatype?: string;
      type?: 'literal' | 'uri' | 'bnode' | string;
      'xml:lang'?: string;
      lang?: string;
    };

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

/**
 * Normalize a binding cell to its full N-Triples object-term string, preserving the
 * datatype/lang suffix (the form the V10 leaf canon consumes). Idempotent on cells
 * already in term-string form; elides the redundant xsd:string datatype.
 */
export function normTerm(x: SparqlBindingCell | undefined | null): string {
  if (typeof x === 'string') return x;
  const o = x ?? {};
  if (o.value === undefined) return '';
  const lang = o['xml:lang'] ?? o.lang;
  if (lang) return `"${o.value}"@${lang}`;
  if (o.datatype && o.datatype !== XSD_STRING) return `"${o.value}"^^<${o.datatype}>`;
  if (o.type === 'uri' || o.type === 'bnode') return o.value;
  return /^["_<]/.test(o.value) ? o.value : `"${o.value}"`;
}

/** Bare string value of a cell (for IRI / non-literal columns that carry no suffix). */
export function valueOf(x: SparqlBindingCell | undefined | null): string {
  return typeof x === 'string' ? x : (x?.value ?? '');
}

/** Lexical form only: strip the surrounding quotes + any datatype/lang suffix. */
export function lexical(x: SparqlBindingCell | undefined | null): string {
  const t = valueOf(x);
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(t);
  return m ? m[1] : t;
}

/** Strip the surrounding `<…>` from an IRI term (→ bare URN/URI), else pass through. */
export function unwrapIri(x: SparqlBindingCell | undefined | null): string {
  const t = valueOf(x);
  return t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
}
