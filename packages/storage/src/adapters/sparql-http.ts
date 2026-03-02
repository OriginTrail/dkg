/**
 * SparqlHttpStore — TripleStore adapter for any SPARQL 1.1 Protocol endpoint.
 *
 * Uses standard W3C SPARQL 1.1 Protocol:
 * - Query: POST to queryEndpoint (application/x-www-form-urlencoded, query=)
 * - Update: POST to updateEndpoint (application/x-www-form-urlencoded, update=)
 *
 * Works with Oxigraph server, Apache Jena Fuseki, GraphDB, Blazegraph,
 * Amazon Neptune, Stardog, and any SPARQL 1.1–compliant server.
 *
 * Example (Oxigraph server):
 *   queryEndpoint: 'http://127.0.0.1:7878/query'
 *   updateEndpoint: 'http://127.0.0.1:7878/update'
 *
 * Example (single URL for both, e.g. Blazegraph):
 *   queryEndpoint: 'http://127.0.0.1:9999/blazegraph/namespace/kb/sparql'
 *   updateEndpoint: same URL
 */

import type {
  TripleStore,
  Quad as DKGQuad,
  QueryResult,
  SelectResult,
  ConstructResult,
  AskResult,
} from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';

export interface SparqlHttpStoreOptions {
  /** SPARQL query endpoint URL (required). */
  queryEndpoint: string;
  /** SPARQL update endpoint URL. Defaults to queryEndpoint if omitted (for stores that use one URL). */
  updateEndpoint?: string;
  /** Request timeout in ms. Default 30_000. */
  timeout?: number;
  /** Optional Authorization header value (e.g. "Bearer <token>" or "Basic <base64>"). */
  auth?: string;
}

export class SparqlHttpStore implements TripleStore {
  private readonly queryEndpoint: string;
  private readonly updateEndpoint: string;
  private readonly timeout: number;
  private readonly headers: Record<string, string>;

  constructor(options: SparqlHttpStoreOptions) {
    if (!options.queryEndpoint?.trim()) {
      throw new Error('sparql-http adapter requires options.queryEndpoint');
    }
    this.queryEndpoint = options.queryEndpoint.replace(/\/$/, '');
    this.updateEndpoint = (options.updateEndpoint ?? options.queryEndpoint).replace(/\/$/, '');
    this.timeout = options.timeout ?? 30_000;
    this.headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (options.auth) {
      this.headers['Authorization'] = options.auth;
    }
  }

  private async postQuery(sparql: string, accept: string): Promise<Response> {
    const res = await fetch(this.queryEndpoint, {
      method: 'POST',
      headers: { ...this.headers, Accept: accept },
      body: `query=${encodeURIComponent(sparql)}`,
      signal: AbortSignal.timeout(this.timeout),
    });
    return res;
  }

  private async postUpdate(update: string): Promise<Response> {
    const res = await fetch(this.updateEndpoint, {
      method: 'POST',
      headers: this.headers,
      body: `update=${encodeURIComponent(update)}`,
      signal: AbortSignal.timeout(this.timeout),
    });
    return res;
  }

  async insert(quads: DKGQuad[]): Promise<void> {
    if (quads.length === 0) return;
    const byGraph = new Map<string, DKGQuad[]>();
    for (const q of quads) {
      const g = q.graph || '';
      if (!byGraph.has(g)) byGraph.set(g, []);
      byGraph.get(g)!.push(q);
    }
    const parts: string[] = [];
    for (const [graph, list] of byGraph) {
      const triples = list.map((q) => `${formatTerm(q.subject)} <${escapeUri(q.predicate)}> ${formatTerm(q.object)} .`).join('\n    ');
      if (graph) {
        parts.push(`GRAPH <${escapeUri(graph)}> {\n    ${triples}\n  }`);
      } else {
        parts.push(triples);
      }
    }
    const update = `INSERT DATA {\n  ${parts.join('\n  ')}\n}`;
    const res = await this.postUpdate(update);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP insert failed (${res.status}): ${text.slice(0, 300)}`);
    }
  }

  async delete(quads: DKGQuad[]): Promise<void> {
    if (quads.length === 0) return;
    const body = quads.map((q) => {
      const g = q.graph ? `GRAPH <${escapeUri(q.graph)}> ` : '';
      return `${g}{ ${formatTerm(q.subject)} <${escapeUri(q.predicate)}> ${formatTerm(q.object)} . }`;
    }).join('\n');
    const update = `DELETE DATA {\n${body}\n}`;
    const res = await this.postUpdate(update);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP delete failed (${res.status}): ${text.slice(0, 300)}`);
    }
  }

  async deleteByPattern(pattern: Partial<DKGQuad>): Promise<number> {
    const graphUri = pattern.graph;
    const before = await this.countQuads(graphUri);
    const s = pattern.subject ? `<${escapeUri(pattern.subject)}>` : '?s';
    const p = pattern.predicate ? `<${escapeUri(pattern.predicate)}>` : '?p';
    const o = pattern.object ? formatTerm(pattern.object) : '?o';
    const triple = `${s} ${p} ${o}`;
    let update: string;
    if (graphUri) {
      update = `DELETE { GRAPH <${escapeUri(graphUri)}> { ${triple} } } WHERE { GRAPH <${escapeUri(graphUri)}> { ${triple} } }`;
    } else {
      update = `DELETE { ?g_ctx { ${triple} } } WHERE { GRAPH ?g_ctx { ${triple} } }`;
    }
    const res = await this.postUpdate(update);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP deleteByPattern failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const after = await this.countQuads(graphUri);
    return Math.max(0, before - after);
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string): Promise<number> {
    const before = await this.countQuads(graphUri);
    const escapedPrefix = escapeString(prefix);
    const update = `DELETE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } } WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${escapedPrefix}")) } }`;
    const res = await this.postUpdate(update);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP deleteBySubjectPrefix failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const after = await this.countQuads(graphUri);
    return Math.max(0, before - after);
  }

  async query(sparql: string): Promise<QueryResult> {
    const trimmed = sparql.trim();
    const upper = trimmed.toUpperCase();
    const isAsk = upper.startsWith('ASK');
    const isConstruct = upper.startsWith('CONSTRUCT') || upper.startsWith('DESCRIBE');

    if (isConstruct) {
      return this.queryConstruct(trimmed);
    }

    const res = await this.postQuery(trimmed, 'application/sparql-results+json');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP query failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as W3CSelectResponse | W3CAskResponse;

    if (isAsk || 'boolean' in json) {
      return { type: 'boolean', value: (json as W3CAskResponse).boolean } satisfies AskResult;
    }

    const sr = json as W3CSelectResponse;
    const vars = sr.head?.vars ?? [];
    const bindings: Array<Record<string, string>> = (sr.results?.bindings ?? []).map((row) => {
      const obj: Record<string, string> = {};
      for (const v of vars) {
        const cell = row[v];
        if (cell) obj[v] = w3cTermToString(cell);
      }
      return obj;
    });
    return { type: 'bindings', bindings } satisfies SelectResult;
  }

  private async queryConstruct(sparql: string): Promise<ConstructResult> {
    const res = await this.postQuery(sparql, 'application/n-quads, text/n-quads');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP construct failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const text = await res.text();
    const quads = parseNQuadsText(text);
    return { type: 'quads', quads };
  }

  async hasGraph(graphUri: string): Promise<boolean> {
    const r = await this.query(`ASK { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } }`);
    return r.type === 'boolean' && r.value;
  }

  async createGraph(_graphUri: string): Promise<void> {
    // Graphs are created implicitly on first insert in SPARQL 1.1.
  }

  async dropGraph(graphUri: string): Promise<void> {
    const update = `DROP SILENT GRAPH <${escapeUri(graphUri)}>`;
    const res = await this.postUpdate(update);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP dropGraph failed (${res.status}): ${text.slice(0, 300)}`);
    }
  }

  async listGraphs(): Promise<string[]> {
    const r = await this.query('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
    if (r.type !== 'bindings') return [];
    return r.bindings.map((b) => b.g).filter(Boolean);
  }

  async countQuads(graphUri?: string): Promise<number> {
    const sparql = graphUri
      ? `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } }`
      : `SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }`;
    const r = await this.query(sparql);
    if (r.type === 'bindings' && r.bindings.length > 0) {
      const c = String(r.bindings[0].c ?? '');
      const stripped = c.replace(/^"|"$/g, '');
      return parseInt(stripped, 10) || 0;
    }
    return 0;
  }

  async close(): Promise<void> {
    // Remote service — nothing to close.
  }
}

// ---------------------------------------------------------------------------
// W3C SPARQL 1.1 JSON result types
// ---------------------------------------------------------------------------

interface W3CTerm {
  type: 'uri' | 'literal' | 'bnode' | 'typed-literal';
  value: string;
  datatype?: string;
  'xml:lang'?: string;
}

interface W3CSelectResponse {
  head: { vars: string[] };
  results: { bindings: Array<Record<string, W3CTerm>> };
}

interface W3CAskResponse {
  boolean: boolean;
}

function w3cTermToString(t: W3CTerm): string {
  if (t.type === 'bnode') return `_:${t.value}`;
  if (t.type === 'literal' || t.type === 'typed-literal') {
    if (t['xml:lang']) return `"${t.value}"@${t['xml:lang']}`;
    if (t.datatype && t.datatype !== 'http://www.w3.org/2001/XMLSchema#string') {
      return `"${t.value}"^^<${t.datatype}>`;
    }
    return `"${t.value}"`;
  }
  return t.value;
}

// ---------------------------------------------------------------------------
// N-Quads / term helpers
// ---------------------------------------------------------------------------

function formatTerm(term: string): string {
  if (term.startsWith('"')) return term;
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

// ---------------------------------------------------------------------------
// Adapter registration
// ---------------------------------------------------------------------------

registerTripleStoreAdapter('sparql-http', async (opts) => {
  const options = opts as SparqlHttpStoreOptions | undefined;
  if (!options?.queryEndpoint) {
    throw new Error('sparql-http adapter requires options.queryEndpoint (and optionally options.updateEndpoint)');
  }
  return new SparqlHttpStore(options);
});
