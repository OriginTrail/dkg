import type {
  TripleStore,
  Quad as DKGQuad,
  QueryOptions,
  UpdateOptions,
  StorePressureSnapshot,
  TripleStoreQueryOptions,
  QueryResult,
  SelectResult,
  ConstructResult,
  AskResult,
} from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';
import { buildBlankNodeSafeDelete } from './sparql-http.js';
import { assertQuadLiteralsMutf8Safe, JAVA_WRITE_UTF_MAX_BYTES } from '@origintrail-official/dkg-core';
import { externalStorePriorityScheduler } from '../store-priority-scheduler.js';

/**
 * BlazegraphStore — TripleStore adapter backed by a remote Blazegraph
 * SPARQL endpoint over HTTP.  Works with any Blazegraph 2.x instance
 * (standalone JAR, Docker, or embedded NanoSparqlServer).
 *
 * All operations are translated to standard SPARQL 1.1 Query / Update
 * plus Blazegraph's N-Quads bulk-insert endpoint.
 */
export class BlazegraphStore implements TripleStore {
  readonly queryCancellation = 'interruptible' as const;

  private readonly url: string;

  constructor(url: string) {
    this.url = url.replace(/\/$/, '');
  }

  private runStoreWork<T>(
    operation: string,
    options: QueryOptions | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    return externalStorePriorityScheduler.run(
      options?.priority,
      options?.source ?? `blazegraph.${operation}`,
      work,
      options?.signal,
    );
  }

  getPressureSnapshot(): StorePressureSnapshot {
    return externalStorePriorityScheduler.snapshot;
  }

  // -------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------

  async insert(quads: DKGQuad[], options?: QueryOptions): Promise<void> {
    if (quads.length === 0) return;
    assertQuadLiteralsMutf8Safe(quads, {
      maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
      label: 'BlazegraphStore.insert',
    });
    // Blazegraph's bulk-insert wire serializer (ASCII-safe N-Quads). See
    // quadToBlazegraphNQuad / toBlazegraphAsciiSafeNQuads for why Blazegraph
    // requires this.
    const nquads = quads.map(quadToBlazegraphNQuad).join('\n') + '\n';
    const res = await this.runStoreWork('insert', {
      ...options,
      source: options?.source ?? 'blazegraph.insert',
    }, async () => fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/x-nquads' },
        body: nquads,
        signal: options?.signal,
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Blazegraph insert failed (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  async delete(quads: DKGQuad[], options?: QueryOptions): Promise<void> {
    if (quads.length === 0) return;
    // Blazegraph is SPARQL 1.1, so blank nodes are illegal in `DELETE DATA`
    // (same constraint as Oxigraph). Reuse the shared blank-node-safe builder
    // so blank-node quads are removed via `DELETE { … } WHERE { … }`.
    const update = buildBlankNodeSafeDelete(quads);
    if (!update) return;
    await this.sparqlUpdate(update, {
      ...options,
      source: options?.source ?? 'blazegraph.delete',
    }, 'delete');
  }

  async deleteByPattern(pattern: Partial<DKGQuad>, options?: QueryOptions): Promise<number> {
    const before = await this.countQuads(pattern.graph, {
      ...options,
      source: options?.source ?? 'blazegraph.deleteByPattern.countBefore',
    });
    const s = pattern.subject ? `<${escapeUri(pattern.subject)}>` : '?s';
    const p = pattern.predicate ? `<${escapeUri(pattern.predicate)}>` : '?p';
    const o = pattern.object ? formatTerm(pattern.object) : '?o';
    const triple = `${s} ${p} ${o}`;
    if (pattern.graph) {
      await this.sparqlUpdate(
        `DELETE { GRAPH <${escapeUri(pattern.graph)}> { ${triple} } } WHERE { GRAPH <${escapeUri(pattern.graph)}> { ${triple} } }`,
        { ...options, source: options?.source ?? 'blazegraph.deleteByPattern' },
        'deleteByPattern',
      );
    } else {
      // `DELETE { ?g_ctx { … } }` is a syntax error — the template needs the
      // `GRAPH` keyword. Rejected with HTTP 400 by a spec-compliant endpoint.
      await this.sparqlUpdate(
        `DELETE { GRAPH ?g_ctx { ${triple} } } WHERE { GRAPH ?g_ctx { ${triple} } }`,
        { ...options, source: options?.source ?? 'blazegraph.deleteByPattern' },
        'deleteByPattern',
      );
    }
    const after = await this.countQuads(pattern.graph, {
      ...options,
      source: options?.source ?? 'blazegraph.deleteByPattern.countAfter',
    });
    return Math.max(0, before - after);
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    const before = await this.countQuads(graphUri, {
      ...options,
      source: options?.source ?? 'blazegraph.deleteBySubjectPrefix.countBefore',
    });
    await this.sparqlUpdate(
      `DELETE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } } WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${escapeString(prefix)}")) } }`,
      { ...options, source: options?.source ?? 'blazegraph.deleteBySubjectPrefix' },
      'deleteBySubjectPrefix',
    );
    const after = await this.countQuads(graphUri, {
      ...options,
      source: options?.source ?? 'blazegraph.deleteBySubjectPrefix.countAfter',
    });
    return Math.max(0, before - after);
  }

  /**
   * Server-side SPARQL UPDATE — POSTs the update verbatim to the endpoint so a
   * `DELETE { … } WHERE { … }` (or `INSERT … WHERE`) runs entirely inside
   * Blazegraph with NO client-side COUNT scans. Uniform with the
   * oxigraph/sparql-http `update()` (`See {@link TripleStore.update}`) so callers
   * can issue one count-free UPDATE instead of a per-pattern
   * `deleteByPattern`/`deleteBySubjectPrefix` loop — each of those brackets its
   * delete with two full-graph `countQuads` scans (see above), which is
   * prohibitive on a CPU-pegged core.
   */
  async update(sparql: string, options?: UpdateOptions): Promise<void> {
    await this.sparqlUpdate(
      sparql,
      { ...options, source: options?.source ?? 'blazegraph.update' },
      'update',
    );
  }

  // -------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------

  async query(sparql: string, options?: TripleStoreQueryOptions): Promise<QueryResult> {
    return this.runStoreWork('query', options, async () => {
      if (options?.signal?.aborted) {
        const reason = options.signal.reason;
        throw reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
      }
      const trimmed = sparql.trim();
      const upper = trimmed.toUpperCase();
      const isAsk = upper.startsWith('ASK');
      const isConstruct = upper.startsWith('CONSTRUCT') || upper.startsWith('DESCRIBE');

      if (isConstruct) {
        return this.queryConstruct(trimmed, options);
      }

      // Direct POST (W3C SPARQL 1.1 Protocol): send the query as the raw
      // request body with `application/sparql-query` rather than URL-encoded
      // form data. Form-encoded bodies (`query=...`) are parsed by Jetty's
      // form handler, which caps at `maxFormContentSize` (~200 KB by default
      // on stock Blazegraph) and rejects larger payloads with HTTP 400
      // "Unable to parse form content". The direct-POST body is not form
      // parsed, so large queries (e.g. CONSTRUCT/VALUES) are not capped.
      // charset=utf-8 is REQUIRED: without it Jetty decodes the raw body as
      // ISO-8859-1, so any non-ASCII character in the query (e.g. a literal
      // in a pattern or FILTER) is mojibake'd server-side and never matches.
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query; charset=utf-8',
          Accept: 'application/sparql-results+json',
        },
        body: trimmed,
        signal: options?.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Blazegraph query failed (${res.status}): ${text.slice(0, 300)}`);
      }

      const json = (await res.json()) as BlazeSelectResponse | BlazeAskResponse;

      if (isAsk || 'boolean' in json) {
        return { type: 'boolean', value: (json as BlazeAskResponse).boolean } satisfies AskResult;
      }

      const sr = json as BlazeSelectResponse;
      const vars = sr.head?.vars ?? [];
      const bindings: Array<Record<string, string>> = (sr.results?.bindings ?? []).map((row) => {
        const obj: Record<string, string> = {};
        for (const v of vars) {
          const cell = row[v];
          if (cell) obj[v] = blazeTermToString(cell);
        }
        return obj;
      });
      return { type: 'bindings', bindings } satisfies SelectResult;
    });
  }

  private async queryConstruct(sparql: string, options?: QueryOptions): Promise<ConstructResult> {
    // charset=utf-8: same ISO-8859-1 default-decode hazard as query()/update().
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query; charset=utf-8',
        Accept: 'text/x-nquads, application/n-quads',
      },
      body: sparql,
      signal: options?.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Blazegraph construct failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const text = await res.text();
    const quads = parseNQuadsText(text);
    return { type: 'quads', quads };
  }

  // -------------------------------------------------------------------
  // Graph management
  // -------------------------------------------------------------------

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    const r = await this.query(
      `ASK { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } }`,
      { ...options, source: options?.source ?? 'blazegraph.hasGraph' },
    );
    return r.type === 'boolean' && r.value;
  }

  async createGraph(_graphUri: string): Promise<void> {
    // Blazegraph creates graphs implicitly on insert.
  }

  async dropGraph(graphUri: string, options?: QueryOptions): Promise<void> {
    await this.sparqlUpdate(
      `DROP SILENT GRAPH <${escapeUri(graphUri)}>`,
      { ...options, source: options?.source ?? 'blazegraph.dropGraph' },
      'dropGraph',
    );
  }

  async listGraphs(options?: TripleStoreQueryOptions): Promise<string[]> {
    const r = await this.query(
      'SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }',
      options,
    );
    if (r.type !== 'bindings') return [];
    return r.bindings.map((b) => b.g).filter(Boolean);
  }

  // -------------------------------------------------------------------
  // Counts
  // -------------------------------------------------------------------

  async countQuads(graphUri?: string, options?: QueryOptions): Promise<number> {
    const sparql = graphUri
      ? `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } }`
      : `SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }`;
    const r = await this.query(sparql, {
      ...options,
      source: options?.source ?? 'blazegraph.countQuads',
    });
    if (r.type === 'bindings' && r.bindings.length > 0) {
      const cell = r.bindings[0].c ?? '';
      const digits = cell.match(/\d+/)?.[0];
      return digits ? parseInt(digits, 10) : 0;
    }
    return 0;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  async close(): Promise<void> {
    // Blazegraph is an external service — nothing to close.
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private async sparqlUpdate(
    update: string,
    options?: QueryOptions,
    operation = 'update',
  ): Promise<void> {
    // Direct POST (W3C SPARQL 1.1 Protocol): send the update as the raw
    // request body with `application/sparql-update` rather than URL-encoded
    // form data (`update=...`). Form-encoded bodies hit Jetty's
    // `maxFormContentSize` cap (~200 KB on stock Blazegraph) and fail with
    // HTTP 400 "Unable to parse form content" — which broke large publishes
    // (a publish issues a DELETE DATA / INSERT over the full quad set). The
    // raw body is not form parsed, so large updates succeed.
    //
    // charset=utf-8 is REQUIRED: without it Jetty decodes the raw body as
    // ISO-8859-1 (the servlet-spec default), so any non-ASCII character in a
    // DELETE DATA / INSERT DATA literal is mojibake'd server-side — deletes
    // silently stop matching and inserts store corrupted values.
    const res = await this.runStoreWork(operation, options, async () => fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sparql-update; charset=utf-8' },
        body: update,
        signal: options?.signal,
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Blazegraph update failed (${res.status}): ${text.slice(0, 300)}`);
    }
  }
}

// =====================================================================
// Blazegraph JSON result types
// =====================================================================

interface BlazeTermValue {
  type: 'uri' | 'literal' | 'bnode' | 'typed-literal';
  value: string;
  datatype?: string;
  'xml:lang'?: string;
}

interface BlazeSelectResponse {
  head: { vars: string[] };
  results: { bindings: Array<Record<string, BlazeTermValue>> };
}

interface BlazeAskResponse {
  boolean: boolean;
}

function escapeNQuadsLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function blazeTermToString(t: BlazeTermValue): string {
  if (t.type === 'bnode') return `_:${t.value}`;
  if (t.type === 'literal' || t.type === 'typed-literal') {
    const escaped = escapeNQuadsLiteral(t.value);
    if (t['xml:lang']) return `"${escaped}"@${t['xml:lang']}`;
    if (t.datatype && t.datatype !== 'http://www.w3.org/2001/XMLSchema#string') {
      return `"${escaped}"^^<${t.datatype}>`;
    }
    return `"${escaped}"`;
  }
  return t.value;
}

// =====================================================================
// N-Quad serialisation / parsing helpers (shared with oxigraph adapter)
// =====================================================================

function quadToNQuad(q: DKGQuad): string {
  const s = formatTerm(q.subject);
  const p = `<${q.predicate}>`;
  const o = formatTerm(q.object);
  const g = q.graph ? ` <${q.graph}>` : '';
  return `${s} ${p} ${o}${g} .`;
}

/**
 * N-Quads serializer for Blazegraph's bulk-insert wire format: a standard
 * N-Quads line ({@link quadToNQuad}) made ASCII-safe
 * ({@link toBlazegraphAsciiSafeNQuads}). This is the single serialization
 * entry point for the adapter's write path, so the Blazegraph wire-format
 * invariant lives at the serialization boundary rather than as a separate
 * post-processing pass a caller must remember to apply. The ASCII-safe pass
 * operates on the assembled line by design: it normalizes `\U` escapes and
 * relies on backslash parity across the whole line, both of which are
 * line-level properties of the rendered N-Quads, not of an individual term.
 */
function quadToBlazegraphNQuad(q: DKGQuad): string {
  return toBlazegraphAsciiSafeNQuads(quadToNQuad(q));
}

/**
 * Make an assembled N-Quads line ASCII-safe for Blazegraph's bulk-insert
 * endpoint. Verified against the stock `lyrasis/blazegraph:2.1.5` image (the
 * image CI and the devnet run):
 *
 *  - The N-Quads parser reads the request body BYTE-wise as ASCII — the
 *    Content-Type charset parameter is ignored — so raw non-ASCII UTF-8
 *    (a 2-byte `é` as much as a 4-byte astral emoji) is replaced with U+FFFD
 *    per byte before parsing: silent stored-value corruption. Downstream a
 *    published KA carrying such a literal fails its storage-ACK merkle
 *    recomputation (MERKLE_MISMATCH_IN_SWM) and the publish dies.
 *  - Big-U escapes are ALSO broken: an in-range `\UXXXXXXXX` is truncated to
 *    its low 16 bits on parse (\U0001F600 😀 → U+F600).
 *  - The one encoding that round-trips every scalar, including the
 *    supplementary plane, is `\uXXXX` per UTF-16 code unit, with astral chars
 *    written as their surrogate pair (backslash-uD83D backslash-uDE00 for
 *    U+1F600) — the exact Java-String form Blazegraph itself emits on
 *    CONSTRUCT read-back.
 *
 * `\uXXXX` is a valid UCHAR in both IRIREF and STRING_LITERAL_QUOTED, so the
 * transform is safe to apply to the whole line. Existing escape sequences are
 * consumed pairwise (backslash parity), so a literal backslash followed by
 * `U…` text (`\\U0001F600`) is never mis-rewritten.
 */
function toBlazegraphAsciiSafeNQuads(line: string): string {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code === 0x5c /* backslash */) {
      // In-range \UXXXXXXXX → equivalent \uXXXX escape(s) Blazegraph parses
      // correctly. Out-of-range \U (> U+10FFFF, unrepresentable) passes through.
      if (line[i + 1] === 'U') {
        const hex = line.slice(i + 2, i + 10);
        if (/^[0-9A-Fa-f]{8}$/.test(hex)) {
          const cp = parseInt(hex, 16);
          if (cp <= 0x10ffff) {
            out += escapeUtf16CodeUnits(String.fromCodePoint(cp));
            i += 9;
            continue;
          }
        }
      }
      // Any other escape: copy the pair verbatim so the escaped char is never
      // re-inspected (preserves backslash parity for the \U check above).
      out += line[i];
      if (i + 1 < line.length) {
        const nextCode = line.charCodeAt(i + 1);
        out += nextCode >= 0x7f ? escapeUtf16CodeUnits(line[i + 1]) : line[i + 1];
        i++;
      }
      continue;
    }
    if (code >= 0x7f) {
      out += escapeUtf16CodeUnits(line[i]);
      continue;
    }
    out += line[i];
  }
  return out;
}

/** `\uXXXX` escape per UTF-16 code unit (surrogate halves stay split). */
function escapeUtf16CodeUnits(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    out += `\\u${s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

function formatTerm(term: string): string {
  if (term.startsWith('"')) {
    const m = term.match(/^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/);
    if (m) return `${m[1]}^^<${m[2]}>`;
    return term;
  }
  if (term.startsWith('_:')) return term;
  if (term.startsWith('<')) return term;
  return `<${term}>`;
}

function parseNQuadsText(text: string): DKGQuad[] {
  const quads: DKGQuad[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(
      /^(<[^>]+>|_:\S+)\s+(<[^>]+>)\s+(<[^>]+>|_:\S+|"(?:[^"\\]|\\.)*"(?:@\S+|\^\^<[^>]+>)?)\s*(?:(<[^>]+>)\s*)?\.$/,
    );
    if (!match) continue;
    quads.push({
      subject: stripAngle(match[1]),
      predicate: stripAngle(match[2]),
      object: match[3].startsWith('<') ? stripAngle(match[3]) : match[3],
      graph: match[4] ? stripAngle(match[4]) : '',
    });
  }
  return quads;
}

function stripAngle(s: string): string {
  return s.startsWith('<') && s.endsWith('>') ? s.slice(1, -1) : s;
}

function escapeUri(uri: string): string {
  return uri.replace(/[<>"{}|\\^`]/g, '');
}

function escapeString(s: string): string {
  return s.replace(/[\\"]/g, '\\$&');
}

// =====================================================================
// Oversized-literal guard
// =====================================================================

/**
 * Java Modified UTF-8 byte length of a string.
 *
 * Blazegraph uses `DataOutputStream.writeUTF()` for index keys, which
 * encodes strings in Java's Modified UTF-8 (MUTF-8).  The key
 * differences from standard UTF-8:
 *   - U+0000 (NUL) is encoded as 2 bytes (0xC0, 0x80) instead of 1
 *   - Supplementary codepoints (U+10000–U+10FFFF) are encoded as a
 *     UTF-16 surrogate pair, each surrogate taking 3 MUTF-8 bytes =
 *     6 bytes total (vs 4 in standard UTF-8)
 *
 * `writeUTF()` hard-caps the encoded length at 65 535 bytes.
 * Exceeding this triggers `java.io.UTFDataFormatException` and causes
 * the entire batch to fail with HTTP 500.
 */
const BLAZEGRAPH_MUTF8_LIMIT = 65_535;

function javaModifiedUtf8Length(str: string): number {
  let len = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0) {
      len += 2;
    } else if (code <= 0x7f) {
      len += 1;
    } else if (code <= 0x7ff) {
      len += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — the low surrogate at i+1 will add another 3
      len += 3;
    } else {
      len += 3;
    }
  }
  return len;
}

/**
 * Check quads for literal objects that would exceed Blazegraph's
 * MUTF-8 index key limit.  Throws with details about the offending
 * quads so callers know the batch was NOT fully persisted.
 */
function rejectOversizedLiterals(quads: DKGQuad[], maxBytes: number): DKGQuad[] {
  const rejected: Array<{ subject: string; predicate: string; mutf8Len: number }> = [];
  const out: DKGQuad[] = [];
  for (const q of quads) {
    if (q.object.startsWith('"')) {
      const mutf8Len = javaModifiedUtf8Length(q.object);
      if (mutf8Len > maxBytes) {
        rejected.push({
          subject: q.subject.slice(0, 120),
          predicate: q.predicate.slice(0, 120),
          mutf8Len,
        });
        continue;
      }
    }
    out.push(q);
  }
  if (rejected.length > 0) {
    const details = rejected
      .map((r) => `  subject=${r.subject} predicate=${r.predicate} (${r.mutf8Len} MUTF-8 bytes)`)
      .join('\n');
    throw new Error(
      `[BlazegraphStore] ${rejected.length} quad(s) exceed Blazegraph's ${maxBytes}-byte MUTF-8 limit ` +
      `and would cause UTFDataFormatException. Rejected quads:\n${details}`,
    );
  }
  return out;
}

// =====================================================================
// Adapter registration
// =====================================================================

registerTripleStoreAdapter('blazegraph', async (opts) => {
  const url = opts?.url as string | undefined;
  if (!url) throw new Error('blazegraph adapter requires options.url (SPARQL endpoint)');
  return new BlazegraphStore(url);
});
