import type {
  TripleStore,
  Quad as DKGQuad,
  QueryResult,
  SelectResult,
  ConstructResult,
  AskResult,
} from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';

/**
 * BlazegraphStore — TripleStore adapter backed by a remote Blazegraph
 * SPARQL endpoint over HTTP.  Works with any Blazegraph 2.x instance
 * (standalone JAR, Docker, or embedded NanoSparqlServer).
 *
 * All operations are translated to standard SPARQL 1.1 Query / Update
 * plus Blazegraph's N-Quads bulk-insert endpoint.
 */
export class BlazegraphStore implements TripleStore {
  private readonly url: string;

  constructor(url: string) {
    this.url = url.replace(/\/$/, '');
  }

  // -------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------

  async insert(quads: DKGQuad[]): Promise<void> {
    if (quads.length === 0) return;
    const nquads = quads.map(quadToNQuad).join('\n') + '\n';
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
    const body = quads.map((q) => {
      const g = q.graph ? `GRAPH <${escapeUri(q.graph)}>` : '';
      const triple = `${formatTerm(q.subject)} <${q.predicate}> ${formatTerm(q.object)} .`;
      return g ? `${g} { ${triple} }` : triple;
    }).join('\n');
    await this.sparqlUpdate(`DELETE DATA {\n${body}\n}`);
  }

  async deleteByPattern(pattern: Partial<DKGQuad>): Promise<number> {
    // PR #229 bot review follow-up (blazegraph.ts:55). The pattern
    // subject can legitimately be a blank node when callers passed
    // through a previously-materialised quad row (e.g. the cleanup
    // path that re-deletes specific bnode-subject quads). Funnel it
    // through `formatTerm` so `_:b0` stays `_:b0` instead of being
    // wrapped as the invalid IRI `<_:b0>`. The predicate is still
    // angle-bracketed because the SPARQL grammar only allows IRIs
    // in predicate position.
    const s = pattern.subject ? formatTerm(pattern.subject) : '?s';
    const p = pattern.predicate ? `<${escapeUri(pattern.predicate)}>` : '?p';
    const o = pattern.object ? formatTerm(pattern.object) : '?o';
    const triple = `${s} ${p} ${o}`;
    if (pattern.graph) {
      // Single-graph case. The intuitive SPARQL-1.1 form
      //   `DELETE { GRAPH <g> { ?s <p> ?o } } WHERE { GRAPH <g> { ?s <p> ?o } }`
      // PARSES on Blazegraph 2.1.5 but silently fails to remove
      // anything through its REST endpoint when the DELETE template
      // contains variables in the subject/predicate/object position
      // (the no-graph branch below documents the same issue; the
      // Oxigraph ↔ Blazegraph parity test `adapter-parity-extra.test.ts`
      // catches this regression — CI run 24809773517 job 72612008748).
      //
      // Mirror the no-graph branch: SELECT every matching tuple first
      // and issue one `DELETE DATA` per row. That's the ONE form that
      // round-trips reliably on Blazegraph 2.1.5, matches the
      // Oxigraph behaviour bit-for-bit, AND gives us an accurate
      // removed count without having to trust a before/after countQuads
      // delta (which is itself untrustworthy if the DELETE silently
      // no-ops and countQuads rounds differently).
      const projVars: string[] = [];
      if (!pattern.subject) projVars.push('?s');
      if (!pattern.predicate) projVars.push('?p');
      if (!pattern.object) projVars.push('?o');
      const proj = projVars.length > 0 ? projVars.join(' ') : '*';
      const selectQ = `SELECT ${proj} WHERE { GRAPH <${escapeUri(pattern.graph)}> { ${triple} } }`;
      const sel = await this.query(selectQ);
      if (sel.type !== 'bindings') return 0;
      let removed = 0;
      const seen = new Set<string>();
      for (const row of sel.bindings) {
        const sx = pattern.subject ?? row['s'];
        const px = pattern.predicate ?? row['p'];
        const ox = pattern.object ?? row['o'];
        if (!sx || !px || !ox) continue;
        const key = `${sx}\u0001${px}\u0001${ox}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // PR #229 bot review (blazegraph.ts:94). The SELECT above
        // materialises every matching row, which in quads mode
        // includes blank-node subjects (`_:b0`). Re-serialising
        // `sx` as `<${escapeUri(sx)}>` turned `_:b0` into the
        // syntactically invalid IRI `<_:b0>` and the resulting
        // `DELETE DATA` either errored on the wire or silently
        // no-op'd, leaving blank-node quads alive forever in
        // Blazegraph. `formatTerm` already encodes blank nodes
        // (`_:foo`), explicit IRIs (`<…>`), and bare strings
        // (wrapped in angle brackets) correctly, so route every
        // RDF position through it. Predicates stay angle-bracketed
        // because by RDF spec a predicate can only be an IRI.
        const tripleData = `${formatTerm(sx)} <${escapeUri(px)}> ${formatTerm(ox)} .`;
        await this.sparqlUpdate(
          `DELETE DATA { GRAPH <${escapeUri(pattern.graph)}> { ${tripleData} } }`,
        );
        removed++;
      }
      return removed;
    }

    // No graph filter: enumerate every matching tuple (named graphs
    // + default graph), then `DELETE DATA` each one individually.
    // The SPARQL-1.1 graph-variable templates `DELETE { GRAPH ?g
    // { ... } } WHERE { GRAPH ?g { ... } }` and `DELETE WHERE
    // { GRAPH ?g { ... } }` both parse on Blazegraph 2.1.5 but
    // neither actually removes any quads through its REST endpoint
    // (it returns 200 OK and a subsequent SELECT still finds the
    // match). Materialising every (s,p,o,g) tuple and DELETE DATA-
    // ing them is the only form that round-trips correctly here.
    const projVars: string[] = [];
    if (!pattern.subject) projVars.push('?s');
    if (!pattern.predicate) projVars.push('?p');
    if (!pattern.object) projVars.push('?o');
    projVars.push('?g');
    const proj = projVars.join(' ');
    const namedQ = `SELECT ${proj} WHERE { GRAPH ?g { ${triple} } }`;
    const defaultProj = projVars.filter((v) => v !== '?g').join(' ') || '*';
    const defaultQ = `SELECT ${defaultProj} WHERE { ${triple} }`;
    let removed = 0;
    const seen = new Set<string>();
    const named = await this.query(namedQ);
    if (named.type === 'bindings') {
      for (const row of named.bindings) {
        const sx = pattern.subject ?? row['s'];
        const px = pattern.predicate ?? row['p'];
        const ox = pattern.object ?? row['o'];
        const g = row['g'];
        if (!sx || !px || !ox || !g) continue;
        // PR #229 bot review (blazegraph.ts:131). Same blank-node
        // round-trip bug as the single-graph branch above: `sx` may
        // be a bnode (`_:b0`), so funnel it through `formatTerm`
        // instead of the IRI-only `<${escapeUri(sx)}>` to avoid
        // emitting the invalid IRI literal `<_:b0>` in the
        // `DELETE DATA` payload.
        const tripleData = `${formatTerm(sx)} <${escapeUri(px)}> ${formatTerm(ox)} .`;
        const key = `${g}\u0001${sx}\u0001${px}\u0001${ox}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await this.sparqlUpdate(
          `DELETE DATA { GRAPH <${escapeUri(g)}> { ${tripleData} } }`,
        );
        removed++;
      }
    }
    // Bot review (PR #229 follow-up, blazegraph.ts:131): the previous
    // revision skipped the default-graph DELETE for any (s,p,o) that
    // matched a named-graph row earlier in this call. In Blazegraph's
    // quads mode the unquoted `{ ${triple} }` pattern returns rows
    // from every graph (default + named), so the suppression avoided
    // double-counting the same quad — but it ALSO silently dropped a
    // real default-graph row when the same (s,p,o) happened to exist
    // in a named graph as well. `deleteByPattern()` is supposed to
    // remove every match across the store, so we re-query the default-
    // dataset view AFTER the named deletes. At that point the only
    // remaining bindings for this pattern are default-graph rows
    // (named-graph instances are gone). We delete each one with
    // `DELETE DATA { triple }` (which in Blazegraph targets the
    // default graph only) and de-dupe via `seen` so an engine that
    // still echoes the pattern multiple times doesn't inflate the
    // count.
    const defAfter = await this.query(defaultQ);
    if (defAfter.type === 'bindings') {
      for (const row of defAfter.bindings) {
        const sx = pattern.subject ?? row['s'];
        const px = pattern.predicate ?? row['p'];
        const ox = pattern.object ?? row['o'];
        if (!sx || !px || !ox) continue;
        // PR #229 bot review (blazegraph.ts:164). Same blank-node
        // round-trip bug as the named-graph branch: route `sx`
        // through `formatTerm` so a bnode (`_:b0`) is emitted as
        // `_:b0` and not the invalid IRI `<_:b0>`. Without this the
        // default-graph DELETE silently no-op'd for blank-node
        // subjects (the `DELETE DATA` either errored on the wire
        // or, on lenient engines, never matched the row), which in
        // turn left blank-node-subject quads pinned in storage and
        // inflated countQuads-driven assertions.
        const tripleData = `${formatTerm(sx)} <${escapeUri(px)}> ${formatTerm(ox)} .`;
        const dedupKey = `__default__\u0001${sx}\u0001${px}\u0001${ox}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        // ASK before DELETE: guarantees the row we're about to delete
        // really exists in the default graph (SELECT { triple } alone
        // is ambiguous in quads mode). If the engine can't represent a
        // DEFAULT-scoped ASK we fall back to issuing the DELETE
        // unconditionally — it's a no-op when the triple is absent.
        let existsInDefault = true;
        try {
          const ask = await this.query(
            `ASK WHERE { ${tripleData} FILTER NOT EXISTS { GRAPH ?__g { ${tripleData} } } }`,
          );
          if (ask.type === 'boolean') existsInDefault = ask.value;
        } catch {
          // ignore — fall through to the unconditional delete
        }
        if (!existsInDefault) continue;
        await this.sparqlUpdate(`DELETE DATA { ${tripleData} }`);
        removed++;
      }
    }
    return removed;
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

  async query(sparql: string): Promise<QueryResult> {
    const trimmed = sparql.trim();
    const upper = trimmed.toUpperCase();
    const isAsk = upper.startsWith('ASK');
    const isConstruct = upper.startsWith('CONSTRUCT') || upper.startsWith('DESCRIBE');

    if (isConstruct) {
      return this.queryConstruct(trimmed);
    }

    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
      },
      body: `query=${encodeURIComponent(trimmed)}`,
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

  private async queryConstruct(sparql: string): Promise<ConstructResult> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/x-nquads, application/n-quads',
      },
      body: `query=${encodeURIComponent(sparql)}`,
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
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `update=${encodeURIComponent(update)}`,
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
// Adapter registration
// =====================================================================

registerTripleStoreAdapter('blazegraph', async (opts) => {
  const url = opts?.url as string | undefined;
  if (!url) throw new Error('blazegraph adapter requires options.url (SPARQL endpoint)');
  return new BlazegraphStore(url);
});
