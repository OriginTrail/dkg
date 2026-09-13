import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  createOperationContext, GRAPH_KA_CONTENT_SCOPE_VERSION,
  type Logger,
} from '@origintrail-official/dkg-core';
import type {
  DKGPublisher,
  SharedMemoryExpiredOperation,
  SharedMemoryExpiryMutationOutcome,
} from '@origintrail-official/dkg-publisher';
import { mapWithConcurrencySettled } from './map-with-concurrency.js';
import { stripLiteral } from './dkg-agent-utils.js';
import {
  describeSharedMemoryGraphs,
  parseSharedMemoryMetaGraph,
  type SharedMemoryGraphDescriptor,
} from './shared-memory-graphs.js';

export const SWM_CLEANUP_BATCH_SIZE = 250;
export const SWM_CLEANUP_MAX_BATCHES = 4;
const SWM_CLEANUP_MAX_CONCURRENT_OPERATIONS = 4;

export interface SwmExpiryCleanupContext {
  store: TripleStore;
  publisher: Pick<DKGPublisher, 'expireSharedMemoryOperation'>;
  log: Pick<Logger, 'info' | 'warn'>;
  isClosed: () => boolean;
}
export interface SwmExpiryCleanupRequest {
  readonly cutoffMs: number;
  readonly continuation?: SwmExpiryCleanupContinuation;
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
interface CleanupBatchResult { outcomes: SharedMemoryExpiryMutationOutcome[]; errors: unknown[] }

/** At most four nonempty pages per invocation; continuation rotates graph priority. */
export async function runSwmExpiryCleanup(
  context: SwmExpiryCleanupContext,
  { cutoffMs, continuation }: SwmExpiryCleanupRequest,
): Promise<SwmExpiryCleanupResult> {
  const { store, log, isClosed } = context;
  const ctx = createOperationContext('share');
  const result: SwmExpiryCleanupResult = { triplesDeleted: 0 };
  const counts = new Map<string, { triples: number; operations: number }>();
  try {
    const cutoff = new Date(cutoffMs).toISOString();
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
        const operations = await loadExpiredOperations(
          store,
          target.metaGraph,
          cutoff,
          SWM_CLEANUP_BATCH_SIZE,
        );
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
          if (outcome.operationRemoved) { count.operations++; metadataProgress++; }
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
          log.warn(ctx, `SWM cleanup stopped for "${target.metaGraph}": batch of ${operations.length} expired operation(s) confirmed no operation metadata removals`);
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

/** Discover one bounded page of expired operation identities and hydrate their lock inputs. */
async function loadExpiredOperations(
  store: TripleStore,
  metaGraph: string,
  cutoff: string,
  limit: number,
): Promise<SharedMemoryExpiredOperation[]> {
  // Bound the identity set before expanding roots or optional V2 fields.
  const result = await store.query(`SELECT ?op ?re ?scopeVersion ?kaUal ?snapshotGraph WHERE {
    { SELECT DISTINCT ?op WHERE {
      GRAPH <${metaGraph}> {
        ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> .
        ?op <http://dkg.io/ontology/publishedAt> ?ts .
        FILTER(?ts < "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
      }
    } LIMIT ${limit} }
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

function decodeExpiredOperations(
  result: Awaited<ReturnType<TripleStore['query']>>,
): SharedMemoryExpiredOperation[] {
  const operations = new Map<string, {
    operation: SharedMemoryExpiredOperation;
    roots: Set<string>;
  }>();
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

async function cleanupExpiredBatch(
  context: SwmExpiryCleanupContext,
  target: CleanupTarget,
  cutoff: string,
  candidates: readonly SharedMemoryExpiredOperation[],
): Promise<CleanupBatchResult> {
  // Keep at most four operation pipelines in flight; the storage scheduler
  // owns lane admission and reservations. Every admitted sibling settles.
  const batch: CleanupBatchResult = { outcomes: [], errors: [] };
  const settled = await mapWithConcurrencySettled(candidates, SWM_CLEANUP_MAX_CONCURRENT_OPERATIONS, async candidate => {
    if (context.isClosed()) return undefined;
    return context.publisher.expireSharedMemoryOperation({
      target,
      candidate,
      cutoff,
      isClosed: context.isClosed,
    });
  });
  for (const outcome of settled) {
    if (outcome.status === 'rejected') batch.errors.push(outcome.reason);
    else if (outcome.value) batch.outcomes.push(outcome.value);
  }
  return batch;
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
  const root = describeSharedMemoryGraphs(contextGraphId);
  const cgPrefix = `did:dkg:context-graph:${contextGraphId}/`;
  const targets = [root];
  for (const graph of await listGraphsByPrefix(store, cgPrefix)) {
    if (graph === root.metaGraph) continue;
    const target = parseSharedMemoryMetaGraph(contextGraphId, graph);
    if (target) targets.push(target);
  }
  return targets;
}
