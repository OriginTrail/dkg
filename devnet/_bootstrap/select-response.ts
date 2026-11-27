/**
 * How a SELECT answer of a DKG daemon (POST /api/query) is read, in ONE place: which
 * envelope holds the rows, how a row and a cell are handled, the shape of a cell and the
 * functions that turn a cell into a term string. `harness.ts` (`queryNode`) and the
 * hash-subscription suite's validator (`public-cg-hash-subscription/wire.ts`) both read
 * an answer through `selectBindings`; `harness.ts` re-exports the cell type and the
 * normalizers, so suites keep importing them from there. A new envelope, or a new cell
 * field, is added here and nowhere else.
 *
 * TWO READINGS, ONE IMPLEMENTATION. `strict` is the only thing that differs:
 *
 *   - `strict: false` is the lenient reading `queryNode` has always had, which every
 *     devnet suite depends on: pick the envelope, and hand back the rows exactly as the
 *     daemon sent them (same array, rows and cells untouched, extra fields kept). It
 *     rejects only an answer with no array of bindings anywhere.
 *   - `strict: true` is the reading of a suite that wants a wrong answer to fail where it
 *     arrives: a present envelope holder must be an object, every row an object and every
 *     cell a term string or an object whose `value`, `datatype`, `type`, `xml:lang` and
 *     `lang` (the fields `normTerm` reads) are strings when present. It returns a new,
 *     projected copy holding only those fields.
 *
 * The envelope is picked by ONE rule in both readings: `result.bindings`, then
 * `results.bindings` (SPARQL 1.1 JSON), then a flat `bindings`, the first that is not
 * null or undefined. (The suite's parser used to take the first that is not undefined, so
 * a `null` there was an error; it now reads past it, as `queryNode` always did.)
 *
 * A rejection is the caller's: `reject(path, expected, actual)` is called with a path from
 * the reply root (named `reply`: `reply.result.bindings[0].o.value`), what was expected
 * there and what arrived, and must throw. `queryNode` throws its plain Error with the node
 * number and the start of the body; the suite throws its `WireShapeError`. This module
 * imports nothing, so it knows neither.
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

/** What a SELECT answer must hold and did not: a path from the reply root, what was expected there and what arrived. Must throw. */
export type RejectSelect = (path: string, expected: string, actual: unknown) => never;

export interface SelectOptions {
  /** `false`: the rows as the daemon sent them. `true`: every holder, row and cell checked and projected (see the header). */
  readonly strict: boolean;
  readonly reject: RejectSelect;
}

/** The rows of a SELECT: one map per row, from variable name to its cell. */
export type SparqlBindingRow = Record<string, SparqlBindingCell>;

/** The envelopes a daemon puts the rows in, in the order they are tried. */
const ENVELOPES = [
  { path: 'result.bindings', keys: ['result', 'bindings'] }, // current daemon shape
  { path: 'results.bindings', keys: ['results', 'bindings'] }, // SPARQL 1.1 JSON
  { path: 'bindings', keys: ['bindings'] }, // legacy flat
] as const;

/** `value?.[key]`: a missing or null value has no members, and anything else is indexed as it is. */
function member(value: unknown, key: string): unknown {
  return value === null || value === undefined ? undefined : (value as Record<string, unknown>)[key];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The value of the first envelope of `json` that has one (not null, not undefined), with
 * its path from the reply root; undefined when none does. It says nothing of what the
 * value is: a caller that wants rows checks for an array.
 */
export function selectEnvelope(json: unknown): { readonly path: string; readonly value: unknown } | undefined {
  for (const { path, keys } of ENVELOPES) {
    const value = keys.reduce<unknown>(member, json);
    if (value !== null && value !== undefined) return { path: `reply.${path}`, value };
  }
  return undefined;
}

/** The fields of a structured cell `normTerm` reads; `strict` keeps exactly these, each a string when present. */
const CELL_FIELDS = ['value', 'datatype', 'type', 'xml:lang', 'lang'] as const;

function projectCell(cell: unknown, path: string, reject: RejectSelect): SparqlBindingCell {
  if (typeof cell === 'string') return cell;
  if (!isObject(cell)) return reject(path, 'an object', cell);
  const projected: Partial<Record<(typeof CELL_FIELDS)[number], string>> = {};
  for (const field of CELL_FIELDS) {
    const entry = cell[field];
    if (entry === undefined) continue;
    if (typeof entry !== 'string') return reject(`${path}.${field}`, 'a string when present', entry);
    projected[field] = entry;
  }
  return projected;
}

function projectRow(row: unknown, path: string, reject: RejectSelect): SparqlBindingRow {
  if (!isObject(row)) return reject(path, 'an object', row);
  const projected: SparqlBindingRow = {};
  for (const [name, cell] of Object.entries(row)) projected[name] = projectCell(cell, `${path}.${name}`, reject);
  return projected;
}

/**
 * The rows of a SELECT answer (`json` is its parsed body), read as `options` say; see the
 * header. The answer is rejected, through `options.reject`, when it has no array of
 * bindings in any envelope and (strict only) when a holder, a row or a cell is malformed.
 */
export function selectBindings(json: unknown, options: SelectOptions): SparqlBindingRow[] {
  const { strict, reject } = options;
  if (strict) {
    if (!isObject(json)) return reject('reply', 'an object', json);
    for (const key of ['result', 'results'] as const) {
      const holder = json[key];
      if (holder !== undefined && !isObject(holder)) return reject(`reply.${key}`, 'an object', holder);
    }
  }
  const envelope = selectEnvelope(json);
  if (envelope === undefined) {
    // A null is read past, but an answer whose only bindings is null says so, instead of "missing".
    const nulled = ENVELOPES.find(({ keys }) => keys.reduce<unknown>(member, json) === null);
    if (nulled !== undefined) return reject(`reply.${nulled.path}`, 'an array', null);
    return reject('reply.result.bindings', 'an array (or results.bindings, or bindings)', undefined);
  }
  if (!Array.isArray(envelope.value)) return reject(envelope.path, 'an array', envelope.value);
  const rows: unknown[] = envelope.value;
  return strict ? rows.map((row, index) => projectRow(row, `${envelope.path}[${index}]`, reject)) : (rows as SparqlBindingRow[]);
}
