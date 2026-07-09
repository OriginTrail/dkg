/**
 * Per-graph SPARQL count + discovery helpers for the UI-driven
 * WM → SWM → VM lifecycle e2e. These let the spec assert the ACTUAL triple
 * migration across memory layers (not just UI affordances): that promote
 * empties the WM assertion graph of blank-node sections and populates
 * `_shared_memory`, and that the lifecycle marker flips WM → SWM.
 *
 * Two hard-won constraints shape every query here (verified against a live
 * rc.15 oxigraph-server devnet node):
 *
 *  1. URI duality. An assertion is identified by TWO URIs:
 *       - DATA graph : did:dkg:context-graph:<cg>/assertion/<agent>/<name>
 *                      (holds the triples; the named root subject IS this URI)
 *       - MARKER      : urn:dkg:assertion:<cg>:<agent>:<name>
 *                      (subject of the `dkg:memoryLayer` lifecycle marker in
 *                       `<cg>/_meta`)
 *     Triple counts key off the DATA graph; layer reads key off the MARKER.
 *
 *  2. Scoped-query guard. With a `contextGraphId` set, the daemon only allows a
 *     hardcoded `GRAPH <iri>` for `<cg>/_meta`; every other partition (assertion
 *     data graphs, `_shared_memory`) is reachable ONLY via a top-level GRAPH
 *     VARIABLE (`GRAPH ?g { … } FILTER(STR(?g) = "<iri>")`) with
 *     `includeContextGraphPartitions: true`. Hardcoding those IRIs returns a
 *     "Scoped query violation" 400. So all data/SWM access below uses a
 *     variable + equality FILTER.
 */
import { devnetApiFetch } from './devnet.js';

const META_LAYER_PREDICATE = 'http://dkg.io/ontology/memoryLayer';

function parseCount(json: any): number {
  const bindings = json?.result?.bindings ?? json?.results?.bindings ?? [];
  const raw = bindings[0]?.c ?? bindings[0]?.cnt;
  const value = typeof raw === 'string' ? raw : raw?.value;
  const m = String(value ?? '').match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

function bindingValues(json: any, key: string): string[] {
  const bindings: any[] = json?.result?.bindings ?? json?.results?.bindings ?? [];
  return bindings
    .map((b) => (typeof b[key] === 'string' ? b[key] : b[key]?.value))
    .filter((v): v is string => !!v);
}

async function runQuery(contextGraphId: string, sparql: string, nodeNum = 1): Promise<any> {
  const res = await devnetApiFetch('/api/query', {
    method: 'POST',
    nodeNum,
    body: JSON.stringify({ sparql, contextGraphId, includeContextGraphPartitions: true }),
  });
  if (!res.ok) {
    throw new Error(`SPARQL query failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Count all triples in a specific named graph (graph-variable + FILTER). */
export async function countTriplesInGraph(
  contextGraphId: string,
  graphUri: string,
  nodeNum = 1,
): Promise<number> {
  const sparql = `SELECT (COUNT(*) AS ?c) WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER(STR(?g) = "${graphUri}")
  }`;
  return parseCount(await runQuery(contextGraphId, sparql, nodeNum));
}

/** Count triples in a graph that carry a blank node in subject or object. */
export async function countBlankNodeTriplesInGraph(
  contextGraphId: string,
  graphUri: string,
  nodeNum = 1,
): Promise<number> {
  const sparql = `SELECT (COUNT(*) AS ?c) WHERE {
    GRAPH ?g { ?s ?p ?o FILTER(isBlank(?s) || isBlank(?o)) }
    FILTER(STR(?g) = "${graphUri}")
  }`;
  return parseCount(await runQuery(contextGraphId, sparql, nodeNum));
}

export interface WmAssertion {
  name: string;
  /** did:dkg:context-graph:<cg>/assertion/<agent>/<name> — holds the triples. */
  dataGraphUri: string;
  /** urn:dkg:assertion:<cg>:<agent>:<name> — subject of the layer marker. */
  markerUri: string;
}

/** did data-graph URI → urn marker URI (the `_meta` memoryLayer subject). */
function deriveMarkerUri(dataGraphUri: string): string {
  // Greedy `(.+)` for the cg segment so a cg that itself contains slashes
  // (e.g. `0xabc…/ninja`) is captured whole, splitting on the LAST `/assertion/`.
  const m = dataGraphUri.match(/^did:dkg:context-graph:(.+)\/assertion\/([^/]+)\/(.+)$/);
  if (!m) throw new Error(`deriveMarkerUri: unexpected data graph shape "${dataGraphUri}"`);
  return `urn:dkg:assertion:${m[1]}:${m[2]}:${m[3]}`;
}

/**
 * Find the most recent WM assertion DATA graph whose URI contains
 * `nameSubstring` (e.g. the sanitized fixture filename). Assertion names are
 * timestamp-prefixed, so lexical max is newest. Returns both the data-graph URI
 * (for triple counts) and the derived marker URI (for layer reads).
 */
export async function findWmAssertion(
  contextGraphId: string,
  nameSubstring: string,
  nodeNum = 1,
): Promise<WmAssertion> {
  // rc.17 per-KA WM data graphs are number-keyed (…/_working_memory/{addr}/{number}), so the
  // assertion NAME no longer appears in the data-graph URI. Resolve through the lifecycle URN
  // (urn:dkg:assertion:…:{name}, which DOES carry the name) and its dkg:assertionGraph pointer
  // to the per-KA data graph. (Legacy name-keyed …/assertion/{addr}/{name} graphs still resolve
  // — their URN carries the same pointer.)
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  const sparql = `SELECT ?urn ?dg WHERE {
    GRAPH <${metaGraph}> {
      ?urn <http://dkg.io/ontology/memoryLayer> "WM" ;
           <http://dkg.io/ontology/assertionGraph> ?dg .
      FILTER(CONTAINS(STR(?urn), "${nameSubstring}"))
    }
  }`;
  const json = await runQuery(contextGraphId, sparql, nodeNum);
  // Assertion names are timestamp-suffixed → lexical max of the URN is newest.
  const rows = ((json?.result?.bindings ?? json?.results?.bindings ?? []) as any[])
    .map((b) => ({
      urn: (typeof b.urn === 'string' ? b.urn : b.urn?.value) as string | undefined,
      dg: (typeof b.dg === 'string' ? b.dg : b.dg?.value) as string | undefined,
    }))
    .filter((r): r is { urn: string; dg: string } => !!r.urn && !!r.dg)
    .sort((a, b) => (a.urn < b.urn ? -1 : a.urn > b.urn ? 1 : 0));
  const pick = rows[rows.length - 1];
  if (!pick) {
    throw new Error(`findWmAssertion: no WM assertion URN contains "${nameSubstring}" in CG ${contextGraphId}`);
  }
  return { name: pick.urn.split(':').pop() ?? pick.urn, dataGraphUri: pick.dg, markerUri: pick.urn };
}

/**
 * Distinct NAMED (non-blank-node) subjects in a graph, excluding the reserved
 * `urn:dkg:file:` / `urn:dkg:extraction:` import bookkeeping. For a
 * markdown-extracted assertion this is the single root subject (which equals
 * the assertion data-graph URI); blank-node section subjects are excluded.
 */
export async function namedRootsInGraph(
  contextGraphId: string,
  graphUri: string,
  nodeNum = 1,
): Promise<string[]> {
  const sparql = `SELECT DISTINCT ?s WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER(STR(?g) = "${graphUri}"
      && !isBlank(?s)
      && !STRSTARTS(STR(?s), "urn:dkg:file:")
      && !STRSTARTS(STR(?s), "urn:dkg:extraction:"))
  }`;
  return bindingValues(await runQuery(contextGraphId, sparql, nodeNum), 's');
}

/**
 * Count triples in `_shared_memory` whose subject is `rootUri` OR one of its
 * skolemized blank-node children (`<rootUri>/.well-known/genid/...`). A
 * non-zero result after promote proves the root + its (formerly blank-node)
 * section structure migrated WM → SWM.
 */
export async function countRootInSharedMemory(
  contextGraphId: string,
  rootUri: string,
  nodeNum = 1,
): Promise<number> {
  const swmGraph = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;
  const genidPrefix = `${rootUri}/.well-known/genid/`;
  // rc.17 per-KA SWM: promoted content lands in …/_shared_memory/{addr}/{number}
  // (number-keyed), not only the legacy …/_shared_memory bucket. Read BOTH (bucket
  // OR per-KA prefix), excluding the staging sub-tree.
  const sparql = `SELECT (COUNT(*) AS ?c) WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER((STR(?g) = "${swmGraph}" || STRSTARTS(STR(?g), "${swmGraph}/"))
      && !STRSTARTS(STR(?g), "${swmGraph}/staging/")
      && (STR(?s) = "${rootUri}" || STRSTARTS(STR(?s), "${genidPrefix}")))
  }`;
  return parseCount(await runQuery(contextGraphId, sparql, nodeNum));
}

/**
 * Count triples in the VM scope (CG partitions that are NOT assertion /
 * shared-memory / meta bookkeeping) attributable to `rootUri` or its
 * skolemized children. A non-zero result means the published entity is visible
 * in Verifiable Memory.
 */
export async function countRootInVmScope(
  contextGraphId: string,
  rootUri: string,
  nodeNum = 1,
): Promise<number> {
  const cgUri = `did:dkg:context-graph:${contextGraphId}`;
  const genidPrefix = `${rootUri}/.well-known/genid/`;
  const sparql = `SELECT (COUNT(*) AS ?c) WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER(
      STRSTARTS(STR(?g), "${cgUri}") &&
      !CONTAINS(STR(?g), "/assertion/") &&
      !CONTAINS(STR(?g), "/_working_memory") &&
      !CONTAINS(STR(?g), "/_shared_memory") &&
      !CONTAINS(STR(?g), "/_meta") &&
      !CONTAINS(STR(?g), "/meta")
    )
    FILTER(STR(?s) = "${rootUri}" || STRSTARTS(STR(?s), "${genidPrefix}"))
  }`;
  return parseCount(await runQuery(contextGraphId, sparql, nodeNum));
}

/** Read the assertion's memoryLayer marker ("WM" | "SWM" | absent). */
export async function readMemoryLayerMarker(
  contextGraphId: string,
  markerUri: string,
  nodeNum = 1,
): Promise<string | null> {
  // The `_meta` partition must be addressed with a HARDCODED `GRAPH <iri>` under
  // the scoped-query guard (see file header) — a `GRAPH ?mg` variable + filter is
  // only legal for the data / `_shared_memory` partitions and 400s on a strict
  // daemon. Build the exact meta-graph IRI and query it directly.
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  const sparql = `SELECT ?layer WHERE {
    GRAPH <${metaGraph}> { <${markerUri}> <${META_LAYER_PREDICATE}> ?layer }
  }`;
  const values = bindingValues(await runQuery(contextGraphId, sparql, nodeNum), 'layer');
  if (values.length === 0) return null;
  return String(values[0]).replace(/^"/, '').replace(/"$/, '');
}
