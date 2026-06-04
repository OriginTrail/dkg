/**
 * In-process SPARQL 1.1 Protocol endpoint backed by an embedded Oxigraph store.
 *
 * It is faithful to `oxigraph-server` for SPARQL *parsing and execution* — it
 * runs the very same engine — so it reproduces server-only behaviour such as
 * the rejection of blank nodes in `DELETE DATA`, WITHOUT needing the server
 * binary or a network service. This lets the `sparql-http` adapter participate
 * in the storage conformance matrix BY DEFAULT, on every CI run, hermetically.
 *
 * Speaks exactly what `SparqlHttpStore` expects:
 *   - POST /update                                  → store.update(), 204 / 400
 *   - POST /query  Accept: sparql-results+json      → SELECT (W3C JSON) / ASK
 *   - POST /query  Accept: n-quads | n-triples      → CONSTRUCT (N-Quads text)
 */
import { createServer, type Server } from 'node:http';
import oxigraph from 'oxigraph';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

function escapeLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function termToNT(t: oxigraph.Term): string {
  switch (t.termType) {
    case 'NamedNode':
      return `<${t.value}>`;
    case 'BlankNode':
      return `_:${t.value}`;
    case 'Literal': {
      const lit = t as oxigraph.Literal;
      let s = `"${escapeLiteral(lit.value)}"`;
      if (lit.language) s += `@${lit.language}`;
      else if (lit.datatype && lit.datatype.value !== XSD_STRING) s += `^^<${lit.datatype.value}>`;
      return s;
    }
    default:
      return `<${t.value}>`;
  }
}

function termToJson(t: oxigraph.Term): Record<string, string> {
  switch (t.termType) {
    case 'NamedNode':
      return { type: 'uri', value: t.value };
    case 'BlankNode':
      return { type: 'bnode', value: t.value };
    case 'Literal': {
      const lit = t as oxigraph.Literal;
      const cell: Record<string, string> = { type: 'literal', value: lit.value };
      if (lit.language) cell['xml:lang'] = lit.language;
      else if (lit.datatype && lit.datatype.value !== XSD_STRING) cell.datatype = lit.datatype.value;
      return cell;
    }
    default:
      return { type: 'uri', value: t.value };
  }
}

function quadToNQ(q: oxigraph.Quad): string {
  const g = q.graph && q.graph.termType !== 'DefaultGraph' ? ` <${q.graph.value}>` : '';
  return `${termToNT(q.subject)} <${q.predicate.value}> ${termToNT(q.object)}${g} .`;
}

export interface OxigraphSparqlEndpoint {
  queryEndpoint: string;
  updateEndpoint: string;
  store: InstanceType<typeof oxigraph.Store>;
  close: () => Promise<void>;
}

export async function startOxigraphSparqlEndpoint(): Promise<OxigraphSparqlEndpoint> {
  const store = new oxigraph.Store();
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        if (req.url?.includes('/update')) {
          store.update(body);
          res.writeHead(204);
          res.end();
          return;
        }
        const accept = String(req.headers['accept'] ?? '');
        const result = store.query(body);

        if (typeof result === 'boolean') {
          res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
          res.end(JSON.stringify({ boolean: result }));
          return;
        }
        if (accept.includes('n-quads') || accept.includes('n-triples')) {
          const quads = (Array.isArray(result) ? (result as oxigraph.Quad[]) : []);
          res.writeHead(200, { 'Content-Type': 'application/n-quads' });
          res.end(quads.map(quadToNQ).join('\n') + '\n');
          return;
        }
        const rows = (Array.isArray(result) ? result : []) as Map<string, oxigraph.Term>[];
        const vars = new Set<string>();
        for (const row of rows) for (const k of row.keys()) vars.add(k);
        const bindings = rows.map((row) => {
          const obj: Record<string, Record<string, string>> = {};
          for (const [k, v] of row.entries()) obj[k] = termToJson(v);
          return obj;
        });
        res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
        res.end(JSON.stringify({ head: { vars: [...vars] }, results: { bindings } }));
      } catch (e) {
        // Mirror oxigraph-server: a malformed/illegal update or query is a 400.
        res.writeHead(400);
        res.end(String((e as Error)?.message ?? e));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return {
    queryEndpoint: `${base}/query`,
    updateEndpoint: `${base}/update`,
    store,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
