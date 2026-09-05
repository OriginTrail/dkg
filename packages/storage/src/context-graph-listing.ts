import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, assertSafeIri, contextGraphDataUri } from '@origintrail-official/dkg-core';
import type { QueryOptions, TripleStore } from './triple-store.js';

const PREFIX = 'did:dkg:context-graph:';
const SOURCE_BATCH_SIZE = 128;

/** Enumerate declared identities, never infer CG/subgraph ownership from a URI. */
export async function listDeclaredContextGraphIds(store: TripleStore, options?: QueryOptions): Promise<string[]> {
  const ids = new Set<string>();
  async function readDeclarations(graphs: string[], type: string, ownSuffix?: string): Promise<void> {
    for (let offset = 0; offset < graphs.length; offset += SOURCE_BATCH_SIZE) {
      const batch = graphs.slice(offset, offset + SOURCE_BATCH_SIZE);
      for (const graph of batch) assertSafeIri(graph);
      const result = await store.query(`
        SELECT DISTINCT ?ctxGraph WHERE {
          VALUES ?g { ${batch.map((graph) => `<${graph}>`).join(' ')} }
          GRAPH ?g {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${type}> .
            FILTER(isIRI(?ctxGraph) && STRSTARTS(STR(?ctxGraph), "${PREFIX}"))
            ${ownSuffix ? `FILTER(STR(?g) = CONCAT(STR(?ctxGraph), "${ownSuffix}"))` : ''}
          }
        }
      `, options);
      if (result.type !== 'bindings') throw new Error('Context graph declaration query did not return bindings');
      for (const row of result.bindings) {
        const raw = row['ctxGraph'];
        if (typeof raw !== 'string') continue;
        const uri = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
        if (!uri.startsWith(PREFIX) || uri.length <= PREFIX.length) continue;
        const id = uri.slice(PREFIX.length);
        // Preserve the root-metadata contract: legacy subgraph metadata can
        // repeat the ContextGraph type, but only root IDs declare themselves
        // here. Registry declarations remain authoritative for other IDs.
        if (ownSuffix === '/_meta' && id.includes('/') && !/^0x[0-9a-fA-F]{40}\/[^/]+$/.test(id)) continue;
        ids.add(id);
      }
    }
  }

  await readDeclarations([
    contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
    contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.AGENTS),
  ], DKG_ONTOLOGY.DKG_CONTEXT_GRAPH);

  // Graph names only select bounded metadata sources. The declaration subject
  // supplies the complete identity, including owner/name, without decomposition.
  const graphs = store.listGraphsByPrefix
    ? await store.listGraphsByPrefix(PREFIX, options)
    : (await store.listGraphs(options)).filter((graph) => graph.startsWith(PREFIX));
  await readDeclarations(graphs.filter((graph) => graph.endsWith('/_meta')), DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, '/_meta');
  await readDeclarations(graphs.filter((graph) => graph.endsWith('/_catalog')), DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH, '/_catalog');
  return [...ids].sort();
}
