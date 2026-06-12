import type {
  TripleStore,
  Quad as DKGQuad,
  QueryOptions,
  QueryResult,
  SelectResult,
  ConstructResult,
  AskResult,
} from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';
import { buildBlankNodeSafeDelete } from './sparql-http.js';

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

  // -------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------

  async insert(quads: DKGQuad[]): Promise<void> {
    if (quads.length === 0) return;
    const safe = rejectOversizedLiterals(quads, BLAZEGRAPH_MUTF8_LIMIT);
    const nquads = safe.map(quadToNQuad).join('\n') + '\n';
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/x-nquads' },
      body: nquads,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Blazegraph insert failed (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  async delete(quads: DKGQuad[]): Promise<void> {
    if (quads.length === 0) return;
    // Blazegraph is SPARQL 1.1, so blank nodes are illegal in `DELETE DATA`
    // (same constraint as Oxigraph). Reuse the shared blank-node-safe builder
    // so blank-node quads are removed via `DELETE { … } WHERE { … }`.
    const update = buildBlankNodeSafeDelete(quads);
    if (!update) return;
    await this.sparqlUpdate(update);
  }

  async deleteByPattern(pattern: Partial<DKGQuad>): Promise<number> {
    const before = await this.countQuads(pattern.graph);
    const s = pattern.subject ? `<${escapeUri(pattern.subject)}>` : '?s';
    const p = pattern.predicate ? `<${escapeUri(pattern.predicate)}>` : '?p';
    const o = pattern.object ? formatTerm(pattern.object) : '?o';
    const triple = `${s} ${p} ${o}`;
    if (pattern.graph) {
      await this.sparqlUpdate(
        `DELETE { GRAPH <${escapeUri(pattern.graph)}> { ${triple} } } WHERE { GRAPH <${escapeUri(pattern.graph)}> { ${triple} } }`,
      );
    } else {
      // `DELETE { ?g_ctx { … } }` is a syntax error — the template needs the
      // `GRAPH` keyword. Rejected with HTTP 400 by a spec-compliant endpoint.
      await this.sparqlUpdate(
        `DELETE { GRAPH ?g_ctx { ${triple} } } WHERE { GRAPH ?g_ctx { ${triple} } }`,
      );
    }
    const after = await this.countQuads(pattern.graph);
    return Math.max(0, before - after);
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string): Promise<number> {
    const before = await this.countQuads(graphUri);
    await this.sparqlUpdate(
      `DELETE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } } WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${escapeString(prefix)}")) } }`,
    );
    const after = await this.countQuads(graphUri);
    return Math.max(0, before - after);
  }

  // -------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------

  async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
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
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
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
  }

  private async queryConstruct(sparql: string, options?: QueryOptions): Promise<ConstructResult> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
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

  async hasGraph(graphUri: string): Promise<boolean> {
    const r = await this.query(
      `ASK { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } }`,
    );
    return r.type === 'boolean' && r.value;
  }

  async createGraph(_graphUri: string): Promise<void> {
    // Blazegraph creates graphs implicitly on insert.
  }

  async dropGraph(graphUri: string): Promise<void> {
    await this.sparqlUpdate(`DROP SILENT GRAPH <${escapeUri(graphUri)}>`);
  }

  async listGraphs(): Promise<string[]> {
    const r = await this.query(
      'SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }',
    );
    if (r.type !== 'bindings') return [];
    return r.bindings.map((b) => b.g).filter(Boolean);
  }

  // -------------------------------------------------------------------
  // Counts
  // -------------------------------------------------------------------

  async countQuads(graphUri?: string): Promise<number> {
    const sparql = graphUri
      ? `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } }`
      : `SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }`;
    const r = await this.query(sparql);
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

  private async sparqlUpdate(update: string): Promise<void> {
    // Direct POST (W3C SPARQL 1.1 Protocol): send the update as the raw
    // request body with `application/sparql-update` rather than URL-encoded
    // form data (`update=...`). Form-encoded bodies hit Jetty's
    // `maxFormContentSize` cap (~200 KB on stock Blazegraph) and fail with
    // HTTP 400 "Unable to parse form content" — which broke large publishes
    // (a publish issues a DELETE DATA / INSERT over the full quad set). The
    // raw body is not form parsed, so large updates succeed.
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: update,
    });
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
