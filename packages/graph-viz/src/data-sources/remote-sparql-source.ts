import type { RdfTriple } from '../core/types.js';
import type {
  GraphDataSource,
  SparqlSelectResult,
  SparqlConstructResult,
  SparqlBinding,
} from './types.js';

export interface RemoteSparqlConfig {
  /** SPARQL endpoint URL (e.g., http://localhost:9999/blazegraph/sparql) */
  endpoint: string;
  /** Optional namespace/repository path appended to endpoint */
  namespace?: string;
  /** Additional HTTP headers (e.g., for auth) */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

/**
 * Remote SPARQL endpoint data source.
 *
 * Connects to any SPARQL 1.1 compatible endpoint (Blazegraph, GraphDB,
 * OriginTrail DKG node, Virtuoso, etc.) via HTTP.
 *
 * @example
 * ```typescript
 * const source = new RemoteSparqlSource({
 *   endpoint: 'http://localhost:9999/blazegraph/sparql',
 *   namespace: 'kb',
 * });
 *
 * const result = await source.construct(`
 *   CONSTRUCT { ?s ?p ?o }
 *   WHERE { ?s a <https://schema.org/SocialMediaPosting> ; ?p ?o }
 *   LIMIT 1000
 * `);
 *
 * viz.loadTriples(result.triples);
 * ```
 */
export class RemoteSparqlSource implements GraphDataSource {
  readonly name: string;
  private _config: Required<RemoteSparqlConfig>;

  constructor(config: RemoteSparqlConfig) {
    this._config = {
      endpoint: config.endpoint,
      namespace: config.namespace ?? '',
      headers: config.headers ?? {},
      timeoutMs: config.timeoutMs ?? 30000,
    };
    this.name = `SPARQL: ${this.endpointUrl}`;
  }

  private get endpointUrl(): string {
    const base = this._config.endpoint.replace(/\/$/, '');
    return this._config.namespace ? `${base}/namespace/${this._config.namespace}/sparql` : base;
  }

  async loadNTriples(_data: string): Promise<void> {
    // For remote sources, data is already in the store.
    // Could implement SPARQL UPDATE INSERT DATA if needed.
    console.warn('RemoteSparqlSource.loadNTriples: remote stores are read-only from the viz. Load data via your KG admin tools.');
  }

  async select(sparql: string): Promise<SparqlSelectResult> {
    const response = await this.executeQuery(sparql, 'application/sparql-results+json');
    const json = await response.json();

    const variables = json.head?.vars ?? [];
    const bindings: SparqlBinding[] = (json.results?.bindings ?? []).map((row: any) => {
      const binding: SparqlBinding = {};
      for (const v of variables) {
        if (row[v]) {
          binding[v] = row[v].value;
        }
      }
      return binding;
    });

    return { variables, bindings };
  }

  async construct(sparql: string): Promise<SparqlConstructResult> {
    const response = await this.executeQuery(sparql, 'application/n-triples');
    const ntText = await response.text();
    const triples = this.parseNTriples(ntText);
    return { triples };
  }

  async tripleCount(): Promise<number> {
    const result = await this.select('SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }');
    return parseInt(result.bindings[0]?.count ?? '0', 10);
  }

  async isReady(): Promise<boolean> {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);
      const response = await fetch(this.endpointUrl, {
        method: 'GET',
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async executeQuery(sparql: string, accept: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this._config.timeoutMs);

    try {
      // W3C SPARQL 1.1 Protocol "query via POST directly" (§2.1.3): send the
      // raw query as the request body with `Content-Type:
      // application/sparql-query`, NOT URL-encoded form data.
      //
      // The old `application/x-www-form-urlencoded` + `query=<encoded>` form
      // hits Jetty's default 200 KB form-content limit on Blazegraph
      // (`UTFDataFormatException` / HTTP 400 "Unable to parse form content")
      // for large queries — e.g. a CONSTRUCT/SELECT carrying a big `VALUES`
      // block — which is the same defect fixed in the Blazegraph/SPARQL-HTTP
      // storage adapters. Direct POST has no such form-size cap and is
      // supported by every SPARQL 1.1 endpoint (Blazegraph, GraphDB,
      // Virtuoso, OriginTrail DKG node, …).
      const response = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          // Caller-supplied headers (e.g. auth) go FIRST so the
          // protocol-required headers below cannot be overridden. The body is
          // always a raw SPARQL query, so a caller default like
          // `Content-Type: application/x-www-form-urlencoded` would corrupt the
          // request (and recreate the large-query form-size regression) or make
          // a compliant endpoint reject it.
          ...this._config.headers,
          'Content-Type': 'application/sparql-query',
          'Accept': accept,
        },
        body: sparql,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`SPARQL query failed: ${response.status} ${response.statusText}`);
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Minimal N-Triples parser for CONSTRUCT results */
  private parseNTriples(text: string): RdfTriple[] {
    const triples: RdfTriple[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Match: <subject> <predicate> <object> . OR <s> <p> "literal"^^<dt> .
      const uriMatch = trimmed.match(/^<([^>]+)>\s+<([^>]+)>\s+<([^>]+)>\s*\.$/);
      if (uriMatch) {
        triples.push({
          subject: uriMatch[1],
          predicate: uriMatch[2],
          object: uriMatch[3],
        });
        continue;
      }

      const litMatch = trimmed.match(/^<([^>]+)>\s+<([^>]+)>\s+"(.+)"(?:\^\^<([^>]+)>|@(\S+))?\s*\.$/);
      if (litMatch) {
        triples.push({
          subject: litMatch[1],
          predicate: litMatch[2],
          object: litMatch[3],
          datatype: litMatch[4],
          language: litMatch[5],
        });
      }
    }

    return triples;
  }
}
