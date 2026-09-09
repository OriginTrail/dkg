import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  createOperationContext, GRAPH_KA_CONTENT_SCOPE_VERSION, isSafeIri,
  type Logger,
} from '@origintrail-official/dkg-core';
import { swmKaWriteLockKey, withKeyedLocks } from '@origintrail-official/dkg-publisher';
import { stripLiteral } from './dkg-agent-utils.js';
import {
  describeSharedMemoryGraphs,
  parseSharedMemoryMetaGraph,
  type SharedMemoryGraphDescriptor,
} from './sync/shared-memory-graphs.js';

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
  /** The same lock domain used by live and local SWM writers. */
  writeLocks: Map<string, Promise<void>>;
  log: Pick<Logger, 'info' | 'warn'>;
  isClosed: () => boolean;
}
export interface SwmExpiryCleanupResult {
  triplesDeleted: number;
  /** Unvisited or still-progressing targets from this finite sweep. */
  continuation?: SwmExpiryCleanupContinuation;
}
export interface SwmExpiryCleanupContinuation {
  readonly remainingTargets: readonly CleanupTarget[];
  /** After finishing these targets, rediscover and rotate past this still-busy graph. */
  readonly restartAfter?: string;
}
type CleanupTarget = SharedMemoryGraphDescriptor;
interface GraphFamily { graphs: string[]; ownershipKeys: Set<string> }
interface ExpiredOperation {
  uri: string;
  roots: string[];
  scope: { kind: 'legacy' } | { kind: 'graph-v2'; kaUal?: string; snapshotGraph?: string };
}
interface CleanupOutcome { triplesDeleted: number; metadataDeleted: number }
interface CleanupBatchResult { outcomes: CleanupOutcome[]; errors: unknown[] }

/** At most four nonempty pages per invocation; continuation rotates graph priority. */
export async function runSwmExpiryCleanup(
  context: SwmExpiryCleanupContext,
  ttlMs: number,
  continuation?: SwmExpiryCleanupContinuation,
  cutoffMs?: number,
): Promise<SwmExpiryCleanupResult> {
  const { store, log, isClosed } = context;
  const ctx = createOperationContext('share');
  const result: SwmExpiryCleanupResult = { triplesDeleted: 0 };
  const counts = new Map<string, { triples: number; operations: number }>();
  try {
    const cutoff = new Date(cutoffMs ?? Date.now() - ttlMs).toISOString();
    const continuing = continuation !== undefined && continuation.remainingTargets.length > 0;
    const targets: CleanupTarget[] = continuing ? [...continuation.remainingTargets] : [];
    let restartAfter = continuing ? continuation.restartAfter : undefined;
    if (!continuing) {
      for (const contextGraphId of await new GraphManager(store).listContextGraphs()) {
        if (isClosed()) return result;
        for (const target of await listSharedMemoryMetaGraphs(store, contextGraphId)) {
          targets.push(target);
        }
      }
      const previous = targets.findIndex(target => target.metaGraph === continuation?.restartAfter);
      if (previous >= 0) targets.push(...targets.splice(0, previous + 1));
    }
    let batches = 0;
    let visited = 0;
    for (; visited < targets.length && !isClosed() && batches < SWM_CLEANUP_MAX_BATCHES; visited++) {
      const target = targets[visited]!;
      let madeProgress = false;
      while (!isClosed() && batches < SWM_CLEANUP_MAX_BATCHES) {
        const operations = await loadExpiredBatch(store, target.metaGraph, cutoff);
        if (isClosed() || operations.length === 0) { madeProgress = false; break; }
        batches++;
        // Each operation rediscovers its graph family after acquiring its own
        // locks so a concurrent writer cannot leave data behind without metadata.
        let metadataProgress = 0;
        const batch = await cleanupExpiredBatch(context, target, cutoff, operations);
        for (const outcome of batch.outcomes) {
          result.triplesDeleted += outcome.triplesDeleted;
          const count = counts.get(target.contextGraphId) ?? { triples: 0, operations: 0 };
          count.triples += outcome.triplesDeleted;
          if (outcome.metadataDeleted > 0) { count.operations++; metadataProgress++; }
          counts.set(target.contextGraphId, count);
        }
        // Account for successful siblings before ending a failed pass. The batch
        // barrier guarantees no operation can outlive this physical flight.
        if (batch.errors.length > 0) {
          throw new AggregateError(batch.errors, batch.errors.map(error =>
            error instanceof Error ? error.message : String(error)).join('; '));
        }
        madeProgress = metadataProgress > 0;
        if (isClosed()) break;
        if (!madeProgress) {
          log.warn(ctx, `SWM cleanup stopped for "${target.metaGraph}": batch of ${operations.length} expired operation(s) deleted no operation metadata`);
          break;
        }
      }
      // Finish unvisited targets before rediscovering. Fresh discovery on every
      // progressing rotation also admits new CGs under continuous arrivals.
      if (madeProgress) restartAfter = target.metaGraph;
    }
    const remainingTargets = targets.slice(visited);
    if (!isClosed() && (remainingTargets.length > 0 || restartAfter !== undefined)) {
      result.continuation = { remainingTargets, restartAfter };
    }
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
  return decodeExpiredOperations(result);
}

/** Revalidate one lock-protected hydrated page immediately before deletion. */
async function loadExpiredOperations(
  store: TripleStore,
  metaGraph: string,
  cutoff: string,
  operationUris: readonly string[],
): Promise<ExpiredOperation[]> {
  const safeUris = operationUris.filter(isSafeIri);
  if (safeUris.length === 0) return [];
  const result = await store.query(`SELECT ?op ?re ?scopeVersion ?kaUal ?snapshotGraph WHERE {
    GRAPH <${metaGraph}> {
      VALUES ?op { ${safeUris.map(uri => `<${uri}>`).join(' ')} }
      ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> .
      ?op <http://dkg.io/ontology/publishedAt> ?ts .
      FILTER(?ts < "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
      OPTIONAL { ?op <http://dkg.io/ontology/rootEntity> ?re }
      OPTIONAL {
        ?op <http://dkg.io/ontology/contentScopeVersion> ?scopeVersion .
        OPTIONAL { ?op <http://dkg.io/ontology/kaUal> ?kaUal }
        OPTIONAL { ?op <http://dkg.io/ontology/publicSnapshotGraph> ?snapshotGraph }
      }
    }
  }`, { source: 'agent.swmCleanup.revalidateOperation' });
  return decodeExpiredOperations(result);
}

function decodeExpiredOperations(
  result: Awaited<ReturnType<TripleStore['query']>>,
): ExpiredOperation[] {
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

function sameExpiredOperation(left: ExpiredOperation, right: ExpiredOperation): boolean {
  if (left.uri !== right.uri || left.scope.kind !== right.scope.kind) return false;
  if (left.roots.length !== right.roots.length
    || [...left.roots].sort().some((root, index) => root !== [...right.roots].sort()[index])) return false;
  return left.scope.kind === 'legacy' || (
    right.scope.kind === 'graph-v2'
    && left.scope.kaUal === right.scope.kaUal
    && left.scope.snapshotGraph === right.scope.snapshotGraph
  );
}

async function cleanupExpiredBatch(
  context: SwmExpiryCleanupContext,
  target: CleanupTarget,
  cutoff: string,
  candidates: readonly ExpiredOperation[],
): Promise<CleanupBatchResult> {
  const settled = await Promise.allSettled(candidates.map(candidate => withKeyedLocks(
    context.writeLocks,
    cleanupWriteLockKeys(target, candidate),
    async () => {
      if (context.isClosed()) return undefined;
      const [current] = await loadExpiredOperations(
        context.store, target.metaGraph, cutoff, [candidate.uri],
      );
      if (context.isClosed() || !current || !sameExpiredOperation(current, candidate)) {
        return undefined;
      }
      const family = await resolveGraphFamily(context.store, target);
      if (context.isClosed()) return undefined;
      return cleanupExpiredOperation(context, target, family, current);
    },
  )));
  const batch: CleanupBatchResult = { outcomes: [], errors: [] };
  for (const result of settled) {
    if (result.status === 'rejected') batch.errors.push(result.reason);
    else if (result.value) batch.outcomes.push(result.value);
  }
  return batch;
}

function cleanupWriteLockKeys(target: CleanupTarget, operation: ExpiredOperation): string[] {
  return [
    ...operation.roots.map(root => `${target.ownershipKey}\0${root}`),
    ...(operation.scope.kind === 'graph-v2' && operation.scope.kaUal
      ? [swmKaWriteLockKey(target.contextGraphId, target.subGraphName, operation.scope.kaUal)]
      : []),
  ];
}

async function resolveGraphFamily(store: TripleStore, target: CleanupTarget): Promise<GraphFamily> {
  return {
    graphs: await listGraphFamily(store, target.dataGraph),
    ownershipKeys: new Set([target.ownershipKey]),
  };
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
async function listSharedMemoryMetaGraphs(store: TripleStore, contextGraphId: string): Promise<CleanupTarget[]> {
  const root = describeSharedMemoryGraphs(contextGraphId)!;
  const cgPrefix = `did:dkg:context-graph:${contextGraphId}/`;
  const targets = [root];
  for (const graph of await listGraphsByPrefix(store, cgPrefix)) {
    if (graph === root.metaGraph) continue;
    const target = parseSharedMemoryMetaGraph(contextGraphId, graph);
    if (target) targets.push(target);
  }
  return targets;
}
