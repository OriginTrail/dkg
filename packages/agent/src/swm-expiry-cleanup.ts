import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  createOperationContext, GRAPH_KA_CONTENT_SCOPE_VERSION, isSafeIri,
  contextGraphWorkspaceMetaGraphUri, validateSubGraphName, type Logger,
} from '@origintrail-official/dkg-core';
import { stripLiteral } from './dkg-agent-utils.js';
import { sharedMemoryOwnershipKeyFromGraph } from './sync/shared-memory-graphs.js';

/** Keep every accepted duration representable by JavaScript Date. Zero disables TTL. */
export function validateSharedMemoryTtlMs(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > 8_640_000_000_000_000) {
    throw new RangeError('sharedMemoryTtlMs must be finite, non-negative and at most 8640000000000000');
  }
}

export const SWM_CLEANUP_BATCH_SIZE = 250;
export const SWM_CLEANUP_MAX_BATCHES = 4;

export interface SwmExpiryCleanupContext {
  store: TripleStore;
  workspaceOwnedEntities: Map<string, Map<string, string>>;
  log: Pick<Logger, 'info' | 'warn'>;
  isClosed: () => boolean;
}
export interface SwmExpiryCleanupResult {
  triplesDeleted: number;
  /** The bounded pass made progress but exhausted its allowance; another pass must probe/drain the remainder. */
  budgetExhausted: boolean;
  nextMetaGraph?: string;
}
interface CleanupTarget { contextGraphId: string; metaGraph: string }
interface GraphFamily { graphs: string[]; ownershipKeys: Set<string> }
interface ExpiredOperation {
  uri: string;
  roots: string[];
  scope: { kind: 'legacy' } | { kind: 'graph-v2'; kaUal?: string; snapshotGraph?: string };
}
interface CleanupOutcome { triplesDeleted: number; metadataDeleted: number }

/** At most four nonempty pages per invocation; continuation rotates graph priority. */
export async function runSwmExpiryCleanup(
  context: SwmExpiryCleanupContext,
  ttlMs: number,
  nextMetaGraph?: string,
  cutoffMs?: number,
): Promise<SwmExpiryCleanupResult> {
  const { store, log, isClosed } = context;
  const ctx = createOperationContext('share');
  const result: SwmExpiryCleanupResult = { triplesDeleted: 0, budgetExhausted: false, nextMetaGraph };
  const counts = new Map<string, { triples: number; operations: number }>();
  try {
    const cutoff = new Date(cutoffMs ?? Date.now() - ttlMs).toISOString();
    const targets: CleanupTarget[] = [];
    for (const contextGraphId of await new GraphManager(store).listContextGraphs()) {
      if (isClosed()) return result;
      for (const metaGraph of await listSharedMemoryMetaGraphs(store, contextGraphId)) {
        targets.push({ contextGraphId, metaGraph });
      }
    }
    const start = Math.max(0, targets.findIndex(target => target.metaGraph === nextMetaGraph));
    let batches = 0;
    let operationsDeleted = 0;
    for (let offset = 0; offset < targets.length && !isClosed() && batches < SWM_CLEANUP_MAX_BATCHES; offset++) {
      const index = (start + offset) % targets.length;
      const target = targets[index]!;
      // A perpetually busy graph cannot consume the first budget on every run.
      result.nextMetaGraph = targets[(index + 1) % targets.length]?.metaGraph;
      while (!isClosed() && batches < SWM_CLEANUP_MAX_BATCHES) {
        const operations = await loadExpiredBatch(store, target.metaGraph, cutoff);
        if (isClosed() || operations.length === 0) break;
        batches++;
        // Metadata selection is live: discover graphs again for every selected
        // page so later arrivals cannot lose metadata while leaving their data.
        const family = await resolveGraphFamily(store, target);
        let metadataProgress = 0;
        for (const operation of operations) {
          if (isClosed()) break;
          const outcome = await cleanupExpiredOperation(context, target, family, operation);
          result.triplesDeleted += outcome.triplesDeleted;
          const count = counts.get(target.contextGraphId) ?? { triples: 0, operations: 0 };
          count.triples += outcome.triplesDeleted;
          if (outcome.metadataDeleted > 0) { count.operations++; metadataProgress++; operationsDeleted++; }
          counts.set(target.contextGraphId, count);
        }
        if (isClosed()) break;
        if (metadataProgress === 0) {
          log.warn(ctx, `SWM cleanup stopped for "${target.metaGraph}": batch of ${operations.length} expired operation(s) deleted no operation metadata`);
          break;
        }
      }
    }
    result.budgetExhausted = !isClosed() && batches === SWM_CLEANUP_MAX_BATCHES && operationsDeleted > 0;
    for (const [id, count] of counts) {
      if (count.operations > 0) log.info(ctx, `SWM cleanup for "${id}": evicted ${count.operations} expired operation(s), ${count.triples} triples`);
    }
  } catch (error) {
    log.warn(ctx, `SWM cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

/** Limit distinct operations before expanding their roots and scope metadata. */
async function loadExpiredBatch(store: TripleStore, metaGraph: string, cutoff: string): Promise<ExpiredOperation[]> {
  const result = await store.query(`SELECT ?op ?re ?scopeVersion ?kaUal ?snapshotGraph WHERE {
    { SELECT DISTINCT ?op WHERE {
      GRAPH <${metaGraph}> {
        ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> .
        ?op <http://dkg.io/ontology/publishedAt> ?ts .
        FILTER(?ts < "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
      }
    } LIMIT ${SWM_CLEANUP_BATCH_SIZE} }
    GRAPH <${metaGraph}> {
      OPTIONAL { ?op <http://dkg.io/ontology/rootEntity> ?re }
      OPTIONAL {
        ?op <http://dkg.io/ontology/contentScopeVersion> ?scopeVersion .
        OPTIONAL { ?op <http://dkg.io/ontology/kaUal> ?kaUal }
        OPTIONAL { ?op <http://dkg.io/ontology/publicSnapshotGraph> ?snapshotGraph }
      }
    }
  }`, { source: 'agent.swmCleanup.expiredOperations' });
  const operations = new Map<string, { operation: ExpiredOperation; roots: Set<string> }>();
  if (result.type !== 'bindings') return [];
  for (const row of result.bindings) {
    if (!row.op) continue;
    let entry = operations.get(row.op);
    if (!entry) {
      const version = row.scopeVersion === undefined ? NaN : Number(stripLiteral(row.scopeVersion));
      entry = {
        operation: {
          uri: row.op, roots: [],
          scope: version === GRAPH_KA_CONTENT_SCOPE_VERSION
            ? { kind: 'graph-v2', kaUal: row.kaUal, snapshotGraph: row.snapshotGraph }
            : { kind: 'legacy' },
        },
        roots: new Set(),
      };
      operations.set(row.op, entry);
    }
    if (row.re) entry.roots.add(row.re);
  }
  return [...operations.values()].map(({ operation, roots }) => ({ ...operation, roots: [...roots] }));
}

async function resolveGraphFamily(store: TripleStore, target: CleanupTarget): Promise<GraphFamily> {
  const graphs = await listGraphFamily(store, target.metaGraph.slice(0, -'_meta'.length));
  const ownershipKeys = new Set<string>();
  for (const graph of graphs) {
    const key = sharedMemoryOwnershipKeyFromGraph(target.contextGraphId, graph);
    if (key) ownershipKeys.add(key);
  }
  return { graphs, ownershipKeys };
}

/** Finish one operation before yielding; stop joins this physical work before closing storage. */
async function cleanupExpiredOperation(
  { store, workspaceOwnedEntities }: SwmExpiryCleanupContext,
  target: CleanupTarget,
  family: GraphFamily,
  operation: ExpiredOperation,
): Promise<CleanupOutcome> {
  let triplesDeleted = await cleanupLegacyRoots(store, family.graphs, operation.roots);
  if (operation.scope.kind === 'graph-v2') {
    triplesDeleted += await cleanupGraphScopedOperation(store, target.metaGraph, operation.uri, operation.scope);
  }
  const metadataDeleted = await store.deleteByPattern({ graph: target.metaGraph, subject: operation.uri });
  triplesDeleted += metadataDeleted;
  for (const root of operation.roots) {
    triplesDeleted += await store.deleteByPattern({ graph: target.metaGraph, subject: root, predicate: 'http://dkg.io/ontology/workspaceOwner' });
    for (const key of family.ownershipKeys) workspaceOwnedEntities.get(key)?.delete(root);
  }
  return { triplesDeleted, metadataDeleted };
}

async function cleanupLegacyRoots(store: TripleStore, graphs: readonly string[], roots: readonly string[]): Promise<number> {
  let deleted = 0;
  for (const root of roots) {
    for (const graph of graphs) {
      deleted += await store.deleteByPattern({ graph, subject: root });
      deleted += await store.deleteBySubjectPrefix(graph, `${root}/.well-known/genid/`);
    }
  }
  return deleted;
}

async function cleanupGraphScopedOperation(
  store: TripleStore,
  metaGraph: string,
  uri: string,
  scope: Extract<ExpiredOperation['scope'], { kind: 'graph-v2' }>,
): Promise<number> {
  let deleted = 0;
  const head = scope.kaUal ? `${scope.kaUal}#dkg-swm-head` : '';
  if (head && isSafeIri(head)) {
    // A newer operation owns its live head/assertion graph independently of this expiry.
    const owner = await store.query(`SELECT ?assertionGraph WHERE {
      GRAPH <${metaGraph}> {
        <${uri}> <http://dkg.io/ontology/shareOperationId> ?opId .
        <${head}> <http://dkg.io/ontology/shareOperationId> ?opId .
        OPTIONAL { <${head}> <http://dkg.io/ontology/assertionGraph> ?assertionGraph }
      }
    } LIMIT 1`, { source: 'agent.swmCleanup.currentHeadOwner' });
    if (owner.type === 'bindings' && owner.bindings.length > 0) {
      const graph = owner.bindings[0]?.assertionGraph;
      if (graph && isSafeIri(graph)) {
        deleted += await store.deleteByPattern({ graph });
        await store.dropGraph(graph);
      }
      deleted += await store.deleteByPattern({ graph: metaGraph, subject: head });
    }
  }
  if (scope.snapshotGraph && isSafeIri(scope.snapshotGraph)) {
    deleted += await store.deleteByPattern({ graph: scope.snapshotGraph });
    await store.dropGraph(scope.snapshotGraph);
  }
  return deleted;
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
