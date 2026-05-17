import type { TripleStore } from '@origintrail-official/dkg-storage';

/**
 * Resolves the set of peer IDs whose published agent profile advertises
 * hosting a given context graph. Backs the optional
 * `getCorePeersHostingContextGraph` dependency on the ACK collector.
 *
 * The agent profile shape (built by `packages/agent/src/profile.ts`) is:
 *
 * ```turtle
 * <did:dkg:agent:<wallet|peerId>>  dkg:peerId  "<peerIdString>" .
 * <did:dkg:agent:<wallet|peerId>>  skill:hostingProfile  <…/.well-known/genid/hosting> .
 * <…/.well-known/genid/hosting>    skill:contextGraphsServed  "<UAL>,<UAL>,..."
 * ```
 *
 * `contextGraphsServed` is a single comma-separated literal rather than
 * many object terms, so the membership check is a delimiter-aware
 * substring test against `,<list>,` to avoid false positives where one
 * UAL is a string prefix of another (e.g. `…/repnet` vs.
 * `…/repnet-edge-smoke`).
 */
export async function resolvePeersHostingContextGraph(
  store: TripleStore,
  contextGraphIdStr: string,
): Promise<string[]> {
  if (!contextGraphIdStr) return [];

  const escapeForSparqlString = (raw: string): string =>
    raw
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');

  const escapedUal = escapeForSparqlString(contextGraphIdStr);
  // Profile triples live in the agent registry named graph
  // (`did:dkg:context-graph:agents`) — see `packages/agent/src/profile.ts`
  // — so the query has to wrap the BGP in `GRAPH ?g { ... }` rather than
  // rely on the default graph (Oxigraph's default graph is empty unless
  // explicitly populated). Using `?g` (instead of pinning to the agent
  // registry IRI) keeps the helper robust to non-production embeddings
  // where profiles might be loaded into a different named graph for
  // testing — at zero cost, since the BGP is selective enough.
  //
  // The `dkg:CoreNode` constraint is mandatory: edge nodes can also
  // emit `skill:contextGraphsServed` (e.g. for join-time discovery),
  // and they don't register the StorageACK protocol handler. Without
  // this filter the collector would target peers that just stream-
  // reset on `/dkg/10.0.0/storage-ack`. The companion
  // `getConnectedCorePeers()` already does protocol-discovery-time
  // filtering, but during early startup it falls back to "all
  // connected peers", so we must enforce the role constraint here too.
  const sparql = `
PREFIX rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX dkg:   <https://dkg.network/ontology#>
PREFIX skill: <https://dkg.origintrail.io/skill#>
SELECT DISTINCT ?peerId WHERE {
  GRAPH ?g {
    ?agent rdf:type dkg:CoreNode ;
           dkg:peerId ?peerId ;
           skill:hostingProfile ?hosting .
    ?hosting skill:contextGraphsServed ?served .
    BIND(CONCAT(",", STR(?served), ",") AS ?normalizedServed)
    BIND(CONCAT(",", "${escapedUal}", ",") AS ?needle)
    FILTER(CONTAINS(?normalizedServed, ?needle))
  }
}
`;

  const result = await store.query(sparql);
  if (result.type !== 'bindings') return [];

  // Bindings carry the literal in its lexical form including wrapping
  // quotes (and an optional ^^<datatype> tail). Strip both, mirroring the
  // `result.bindings[…]?.['x']?.replace(/^"|"$/g, '')` pattern used
  // throughout `packages/agent/src/dkg-agent.ts`.
  const stripLiteral = (raw: string): string =>
    raw
      .replace(/^"/, '')
      .replace(/"(?:\^\^.*)?$/, '');

  const peers = new Set<string>();
  for (const row of result.bindings) {
    const raw = row['peerId'];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const peerId = stripLiteral(raw);
    if (peerId.length > 0) peers.add(peerId);
  }
  return [...peers];
}
