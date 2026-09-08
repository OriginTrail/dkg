import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  createOperationContext, GRAPH_KA_CONTENT_SCOPE_VERSION, isSafeIri,
  contextGraphWorkspaceMetaGraphUri, validateSubGraphName, type Logger,
} from '@origintrail-official/dkg-core';
import { stripLiteral } from './dkg-agent-utils.js';
import { sharedMemoryOwnershipKeyFromGraph } from './sync/shared-memory-graphs.js';

export const SWM_CLEANUP_BATCH_SIZE = 250;

interface SwmExpiryCleanupContext {
  store: TripleStore;
  workspaceOwnedEntities: Map<string, Map<string, string>>;
  log: Pick<Logger, 'info' | 'warn'>;
  isClosed: () => boolean;
}

/** Bounded expiry pass. The agent owns single-flight admission and shutdown draining. */
export async function runSwmExpiryCleanup(
  { store, workspaceOwnedEntities, log, isClosed }: SwmExpiryCleanupContext,
  ttlMs: number,
): Promise<number> {
  const ctx = createOperationContext('share');
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  let totalDeleted = 0;

  try {
    const graphManager = new GraphManager(store);
    const contextGraphs = await graphManager.listContextGraphs();

    for (const pid of contextGraphs) {
      if (isClosed()) break;
      let graphDeleted = 0;
      let expiredOpsCount = 0;

      // Graph-scoped V2 operations and heads for sub-graph shares live in
      // per-subgraph `…/{subGraph}/_shared_memory_meta` graphs (see
      // GraphManager.sharedMemoryMetaUri), not only in the root
      // `…/_shared_memory_meta` bucket — expire every meta graph.
      const wsMetaGraphs = await listSharedMemoryMetaGraphs(store, pid);

      for (const wsMetaGraph of wsMetaGraphs) {
        if (isClosed()) break;
        // Each meta graph describes exactly one SWM data bucket:
        // `…/_shared_memory_meta` ↔ `…/_shared_memory` (root or per-subgraph).
        const wsGraph = wsMetaGraph.slice(0, -'_meta'.length);

        let family: { graphs: string[]; ownershipKeys: Set<string> } | undefined;
        while (!isClosed()) {
          const expiredOps = await store.query(
            `SELECT DISTINCT ?op WHERE {
            GRAPH <${wsMetaGraph}> {
              ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> .
              ?op <http://dkg.io/ontology/publishedAt> ?ts .
              FILTER(?ts < "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
            }
          } LIMIT ${SWM_CLEANUP_BATCH_SIZE}`,
            { source: 'agent.swmCleanup.expiredOperations' },
          );

          if (expiredOps.type !== 'bindings' || expiredOps.bindings.length === 0) break;
          if (!family) {
            const graphs = await listGraphFamily(store, wsGraph);
            const ownershipKeys = new Set<string>();
            for (const graph of graphs) {
              const key = sharedMemoryOwnershipKeyFromGraph(pid, graph);
              if (key) ownershipKeys.add(key);
            }
            family = { graphs, ownershipKeys };
          }
          const wsGraphs = family.graphs;
          let metadataProgress = 0;

          for (const row of expiredOps.bindings) {
            if (isClosed()) break;
            const opUri = row['op'];
            if (!opUri) continue;

            const rootEntitiesResult = await store.query(
              `SELECT ?re WHERE {
              GRAPH <${wsMetaGraph}> {
                <${opUri}> <http://dkg.io/ontology/rootEntity> ?re .
              }
            }`,
              { source: 'agent.swmCleanup.operationRoots' },
            );

            const rootEntities: string[] = [];
            if (rootEntitiesResult.type === 'bindings') {
              for (const r of rootEntitiesResult.bindings) {
                if (r['re']) rootEntities.push(r['re']);
              }
            }

            // Uniform layout: span the per-KA …/_shared_memory/{addr}/{number} graphs + bucket.
            for (const re of rootEntities) {
              for (const g of wsGraphs) {
                // Exact root only; then skolemized descendants only (prefix would over-delete e.g. urn:foo vs urn:foobar)
                const exactDeleted = await store.deleteByPattern({ graph: g, subject: re });
                graphDeleted += exactDeleted;
                const childPrefix = `${re}/.well-known/genid/`;
                const childDeleted = await store.deleteBySubjectPrefix(g, childPrefix);
                graphDeleted += childDeleted;
              }
            }

            // Graph-scoped V2 operations (dkg:contentScopeVersion=2) have no
            // rootEntity rows, so the legacy sweep above no-ops for them and
            // the generic op-subject delete below would strand the rest of the
            // KA: the per-KA SWM assertion graph, the `${kaUal}#dkg-swm-head`
            // subject and the operation's public snapshot graph. Discard them
            // here. The snapshot graph always dies with its operation; the
            // head and assertion graph die only when the head still points at
            // THIS operation — when a newer operation owns the head they carry
            // live data, and a surviving head whose operation rows are gone
            // reads as CORRUPT in resolveKnowledgeAssetWorkspaceHead.
            const v2Meta = await store.query(
              `SELECT ?scopeVersion ?kaUal ?snapshotGraph WHERE {
              GRAPH <${wsMetaGraph}> {
                <${opUri}> <http://dkg.io/ontology/contentScopeVersion> ?scopeVersion .
                OPTIONAL { <${opUri}> <http://dkg.io/ontology/kaUal> ?kaUal }
                OPTIONAL { <${opUri}> <http://dkg.io/ontology/publicSnapshotGraph> ?snapshotGraph }
              }
            } LIMIT 1`,
              { source: 'agent.swmCleanup.graphScopedMetadata' },
            );
            const v2Row = v2Meta.type === 'bindings' ? v2Meta.bindings[0] : undefined;
            const scopeVersion = v2Row?.['scopeVersion'] === undefined ? NaN : Number(stripLiteral(v2Row['scopeVersion']));
            if (scopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION) {
              const kaUal = v2Row?.['kaUal'];
              const headSubject = kaUal ? `${kaUal}#dkg-swm-head` : '';
              if (headSubject && isSafeIri(headSubject)) {
                // The head is owned by exactly one operation. Join on the
                // dkg:shareOperationId literal (both rows are written by the
                // same `lit()` serializer) so this op's expiry only tears the
                // head down when the head still references it.
                const headOwned = await store.query(
                  `SELECT ?assertionGraph WHERE {
                  GRAPH <${wsMetaGraph}> {
                    <${opUri}> <http://dkg.io/ontology/shareOperationId> ?opId .
                    <${headSubject}> <http://dkg.io/ontology/shareOperationId> ?opId .
                    OPTIONAL { <${headSubject}> <http://dkg.io/ontology/assertionGraph> ?assertionGraph }
                  }
                } LIMIT 1`,
                  { source: 'agent.swmCleanup.currentHeadOwner' },
                );
                if (headOwned.type === 'bindings' && headOwned.bindings.length > 0) {
                  // Whole KA expired: drop the per-KA SWM assertion graph and
                  // the current-head subject with the operation.
                  const assertionGraph = headOwned.bindings[0]?.['assertionGraph'];
                  if (assertionGraph && isSafeIri(assertionGraph)) {
                    graphDeleted += await store.deleteByPattern({ graph: assertionGraph });
                    await store.dropGraph(assertionGraph);
                  }
                  graphDeleted += await store.deleteByPattern({ graph: wsMetaGraph, subject: headSubject });
                }
              }
              const snapshotGraph = v2Row?.['snapshotGraph'];
              if (snapshotGraph && isSafeIri(snapshotGraph)) {
                graphDeleted += await store.deleteByPattern({ graph: snapshotGraph });
                await store.dropGraph(snapshotGraph);
              }
            }

            // Exact subject delete for this operation's metadata (prefix would match opUri that are prefixes of others, e.g. ...:ws-123 vs ...:ws-1234)
            const metaDeleted = await store.deleteByPattern({ graph: wsMetaGraph, subject: opUri });
            graphDeleted += metaDeleted;
            if (metaDeleted > 0) { metadataProgress++; expiredOpsCount++; }

            for (const re of rootEntities) {
              const ownerDeleted = await store.deleteByPattern({
                graph: wsMetaGraph, subject: re, predicate: 'http://dkg.io/ontology/workspaceOwner',
              });
              graphDeleted += ownerDeleted;
            }

            // Evict every per-subgraph ownership key for the expired roots.
            // SWM data now spans the root workspace graph plus the per-KA /
            // subgraph `…/_shared_memory/{addr}/{number}` graphs (wsGraphs), and
            // ownership is cached under one key per graph family:
            // `pid` for the root/bucket and `${pid}\0${subGraph}` for per-subgraph
            // graphs (see sharedMemoryOwnershipKeyFromGraph). Only clearing the
            // `pid`-keyed map would leave the per-subgraph entries behind, so an
            // expired root could still look owned and mis-arbitrate later writes.
            for (const ownershipKey of family.ownershipKeys) {
              const ownedSet = workspaceOwnedEntities.get(ownershipKey);
              if (!ownedSet) continue;
              for (const re of rootEntities) {
                ownedSet.delete(re);
              }
            }
          }
          if (isClosed()) break;
          if (metadataProgress === 0) {
            log.warn(ctx, `SWM cleanup stopped for "${wsMetaGraph}": batch of ${expiredOps.bindings.length} expired operation(s) deleted no operation metadata`);
            break;
          }
        }
      }

      totalDeleted += graphDeleted;
      if (expiredOpsCount > 0) {
        log.info(ctx, `SWM cleanup for "${pid}": evicted ${expiredOpsCount} expired operation(s), ${graphDeleted} triples`);
      }
    }
  } catch (err) {
    log.warn(ctx, `SWM cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return totalDeleted;
}

async function listGraphFamily(store: TripleStore, rootGraph: string): Promise<string[]> {
  const graphs = await listGraphsByPrefix(store, `${rootGraph}/`);
  if (await store.hasGraph(rootGraph)) {
    graphs.unshift(rootGraph);
  }
  return graphs;
}

async function listGraphsByPrefix(store: TripleStore, prefix: string): Promise<string[]> {
  return store.listGraphsByPrefix
    ? store.listGraphsByPrefix(prefix)
    : (await store.listGraphs()).filter((graph) => graph.startsWith(prefix));
}

/**
 * Enumerate every SWM meta graph of one context graph: the root
 * `…/_shared_memory_meta` bucket plus one `…/{subGraph}/_shared_memory_meta`
 * per sub-graph (graph-scoped V2 sub-graph shares store their operations and
 * heads there — see GraphManager.sharedMemoryMetaUri). Sub-graph names can
 * never start with `_` or contain `/` (validateSubGraphName), so protocol
 * families such as `…/_verifiable_memory/…` or `…/_shared_memory_snapshots/…`
 * can never be misread as a sub-graph meta graph.
 */
async function listSharedMemoryMetaGraphs(store: TripleStore, contextGraphId: string): Promise<string[]> {
  const rootMetaGraph = contextGraphWorkspaceMetaGraphUri(contextGraphId);
  const cgPrefix = `did:dkg:context-graph:${contextGraphId}/`;
  const metaSuffix = '/_shared_memory_meta';
  const metaGraphs = [rootMetaGraph];
  for (const graph of await listGraphsByPrefix(store, cgPrefix)) {
    if (graph === rootMetaGraph || !graph.endsWith(metaSuffix)) continue;
    const subGraphName = graph.slice(cgPrefix.length, graph.length - metaSuffix.length);
    if (!validateSubGraphName(subGraphName).valid) continue;
    metaGraphs.push(graph);
  }
  return metaGraphs;
}
