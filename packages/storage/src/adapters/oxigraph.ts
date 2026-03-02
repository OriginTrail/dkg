import oxigraph from 'oxigraph';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  TripleStore,
  Quad as DKGQuad,
  QueryResult,
  SelectResult,
  ConstructResult,
  AskResult,
} from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';

type OxStore = InstanceType<typeof oxigraph.Store>;
type OxTerm = oxigraph.Term;
type OxQuad = oxigraph.Quad;

export class OxigraphStore implements TripleStore {
  private store: OxStore;
  private persistPath: string | undefined;

  /**
   * @param persistPath  If provided, the store will dump/load N-Quads
   *   to this file path for persistence across restarts. The underlying
   *   store is still in-memory, but data is hydrated on construction
   *   and flushed on insert/delete/close.
   */
  constructor(persistPath?: string) {
    this.store = new oxigraph.Store();
    this.persistPath = persistPath;
    if (persistPath) {
      this.hydrateSync(persistPath);
    }
  }

  private hydrateSync(filePath: string): void {
    try {
      if (!existsSync(filePath)) return;
      const data = readFileSync(filePath, 'utf-8') as string;
      if (data.trim()) {
        this.store.load(data, { format: 'application/n-quads' });
      }
    } catch {
      // File missing or corrupt — start empty.
    }
  }

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  private scheduleFlush(): void {
    if (!this.persistPath || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, 50);
  }

  private async flushNow(): Promise<void> {
    if (!this.persistPath || this.flushing) return;
    this.flushing = true;
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      const nquads = this.store.dump({ format: 'application/n-quads' });
      await writeFile(this.persistPath, nquads, 'utf-8');
    } catch {
      // Best-effort persistence.
    } finally {
      this.flushing = false;
    }
  }

  async insert(quads: DKGQuad[]): Promise<void> {
    if (quads.length === 0) return;
    const nquads = quads.map(quadToNQuad).join('\n') + '\n';
    this.store.load(nquads, { format: 'application/n-quads' });
    this.scheduleFlush();
  }

  async delete(quads: DKGQuad[]): Promise<void> {
    for (const q of quads) {
      const oxQuad = toOxQuad(q);
      if (oxQuad) this.store.delete(oxQuad);
    }
    this.scheduleFlush();
  }

  async deleteByPattern(pattern: Partial<DKGQuad>): Promise<number> {
    const matches = this.store.match(
      pattern.subject ? oxigraph.namedNode(pattern.subject) : null,
      pattern.predicate ? oxigraph.namedNode(pattern.predicate) : null,
      pattern.object ? parseTerm(pattern.object) : null,
      pattern.graph ? oxigraph.namedNode(pattern.graph) : null,
    );
    for (const q of matches) {
      this.store.delete(q);
    }
    if (matches.length > 0) this.scheduleFlush();
    return matches.length;
  }

  async query(sparql: string): Promise<QueryResult> {
    const result = this.store.query(sparql);

    if (typeof result === 'boolean') {
      return { type: 'boolean', value: result } satisfies AskResult;
    }

    if (typeof result === 'string') {
      return { type: 'bindings', bindings: [] } satisfies SelectResult;
    }

    if (!Array.isArray(result) || result.length === 0) {
      return { type: 'bindings', bindings: [] } satisfies SelectResult;
    }

    const first = result[0];
    if (first instanceof Map) {
      const bindings = (result as Map<string, OxTerm>[]).map((row) => {
        const obj: Record<string, string> = {};
        for (const [key, term] of row.entries()) {
          obj[key] = termToString(term);
        }
        return obj;
      });
      return { type: 'bindings', bindings } satisfies SelectResult;
    }


    const quads = (result as OxQuad[]).map(fromOxQuad);
    return { type: 'quads', quads } satisfies ConstructResult;
  }

  async hasGraph(graphUri: string): Promise<boolean> {
    const matches = this.store.match(
      null,
      null,
      null,
      oxigraph.namedNode(graphUri),
    );
    return matches.length > 0;
  }

  async createGraph(_graphUri: string): Promise<void> {
    // Oxigraph creates graphs implicitly on insert — no-op.
  }

  async dropGraph(graphUri: string): Promise<void> {
    this.store.update(`DROP SILENT GRAPH <${escapeUri(graphUri)}>`);
    this.scheduleFlush();
  }

  async listGraphs(): Promise<string[]> {
    const result = this.store.query(
      'SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }',
    );
    if (typeof result === 'boolean' || typeof result === 'string') return [];
    if (!Array.isArray(result)) return [];
    return (result as Map<string, OxTerm>[])
      .filter((row): row is Map<string, OxTerm> => row instanceof Map)
      .map((row) => {
        const g = row.get('g');
        return g ? g.value : '';
      })
      .filter(Boolean);
  }

  async deleteBySubjectPrefix(
    graphUri: string,
    prefix: string,
  ): Promise<number> {
    const before = this.store.size;
    this.store.update(
      `DELETE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } } WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${escapeString(prefix)}")) } }`,
    );
    const removed = before - this.store.size;
    if (removed > 0) this.scheduleFlush();
    return removed;
  }

  async countQuads(graphUri?: string): Promise<number> {
    if (graphUri) {
      return this.store.match(
        null,
        null,
        null,
        oxigraph.namedNode(graphUri),
      ).length;
    }
    return this.store.size;
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushNow();
  }
}

function quadToNQuad(q: DKGQuad): string {
  const s = formatTerm(q.subject);
  const p = `<${q.predicate}>`;
  const o = formatTerm(q.object);
  const g = q.graph ? ` <${q.graph}>` : '';
  return `${s} ${p} ${o}${g} .`;
}

function formatTerm(term: string): string {
  if (term.startsWith('"')) return term;
  if (term.startsWith('_:')) return term;
  if (term.startsWith('<')) return term;
  return `<${term}>`;
}

function parseTerm(term: string): oxigraph.NamedNode | oxigraph.Literal | oxigraph.BlankNode {
  if (term.startsWith('"')) {
    const match = term.match(/^"(.*)"(?:@(\S+)|\^\^<(.+)>)?$/s);
    if (match) {
      if (match[2]) return oxigraph.literal(match[1], match[2]);
      if (match[3]) return oxigraph.literal(match[1], oxigraph.namedNode(match[3]));
      return oxigraph.literal(match[1]);
    }
    return oxigraph.literal(term.slice(1, -1));
  }
  if (term.startsWith('_:')) return oxigraph.blankNode(term.slice(2));
  return oxigraph.namedNode(term);
}

function toOxQuad(q: DKGQuad): oxigraph.Quad | null {
  try {
    const subject = parseTerm(q.subject) as oxigraph.NamedNode | oxigraph.BlankNode;
    const predicate = oxigraph.namedNode(q.predicate);
    const object = parseTerm(q.object);
    const graph = q.graph
      ? oxigraph.namedNode(q.graph)
      : oxigraph.defaultGraph();
    return oxigraph.quad(subject, predicate, object, graph);
  } catch {
    return null;
  }
}

function fromOxQuad(oxq: OxQuad): DKGQuad {
  return {
    subject: termToString(oxq.subject),
    predicate: oxq.predicate.value,
    object: termToString(oxq.object),
    graph:
      oxq.graph.termType === 'DefaultGraph' ? '' : oxq.graph.value,
  };
}

function termToString(t: OxTerm): string {
  if (t.termType === 'Literal') {
    const lit = t as oxigraph.Literal;
    if (lit.language) return `"${lit.value}"@${lit.language}`;
    if (
      lit.datatype &&
      lit.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string'
    ) {
      return `"${lit.value}"^^<${lit.datatype.value}>`;
    }
    return `"${lit.value}"`;
  }
  if (t.termType === 'BlankNode') return `_:${t.value}`;
  return t.value;
}

function escapeUri(uri: string): string {
  return uri.replace(/[<>"{}|\\^`]/g, '');
}

function escapeString(s: string): string {
  return s.replace(/[\\"]/g, '\\$&');
}

registerTripleStoreAdapter('oxigraph', async () => new OxigraphStore());
registerTripleStoreAdapter('oxigraph-persistent', async (opts) => {
  const filePath = opts?.path as string | undefined;
  if (!filePath) throw new Error('oxigraph-persistent requires options.path');
  return new OxigraphStore(filePath);
});
