import {
  resolveSharedMemoryScopeGraphs,
  type TripleStore,
  withCountedStoreMutation,
} from '@origintrail-official/dkg-storage';
import {
  describeSharedMemoryScope,
  isSafeIri,
  type SharedMemoryScopeDescriptor,
} from '@origintrail-official/dkg-core';
import {
  swmEntityWriteLockKey,
  swmKaWriteLockKey,
  withKeyedLocks,
} from './keyed-lock.js';
import {
  decodeSharedMemoryExpiredOperations,
  type SharedMemoryExpiredOperation,
} from './swm-expiry-operation.js';

export type { SharedMemoryExpiredOperation } from './swm-expiry-operation.js';

export interface SharedMemoryExpiryMutationRequest {
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly candidate: SharedMemoryExpiredOperation;
  readonly cutoff: string;
  readonly isClosed: () => boolean;
}

export interface SharedMemoryExpiryMutationOutcome {
  readonly triplesDeleted: number;
  readonly operationRemoved: boolean;
}

interface SharedMemoryExpiryMutationCoordinatorOptions {
  readonly store: TripleStore;
  readonly ownedEntities: Map<string, Map<string, string>>;
  readonly writeLocks: Map<string, Promise<void>>;
}

/**
 * Publisher-owned mutation boundary for expiring one SWM operation.
 *
 * Discovery and batching deliberately remain with the agent's maintenance
 * worker. Everything that depends on the publisher's physical layout,
 * ownership cache, or write-lock namespace stays behind this coordinator.
 */
export class SharedMemoryExpiryMutationCoordinator {
  readonly #store: TripleStore;
  readonly #ownedEntities: Map<string, Map<string, string>>;
  readonly #writeLocks: Map<string, Promise<void>>;

  constructor(options: SharedMemoryExpiryMutationCoordinatorOptions) {
    this.#store = options.store;
    this.#ownedEntities = options.ownedEntities;
    this.#writeLocks = options.writeLocks;
  }

  async expire(
    request: SharedMemoryExpiryMutationRequest,
  ): Promise<SharedMemoryExpiryMutationOutcome | undefined> {
    const { contextGraphId, subGraphName, candidate, cutoff, isClosed } = request;
    if (isClosed() || !isSafeIri(candidate.uri)) return undefined;
    const target = describeSharedMemoryScope(contextGraphId, subGraphName);
    return withKeyedLocks(this.#writeLocks, this.#writeLockKeys(target, candidate), async () => {
      if (isClosed()) return undefined;
      const current = await this.#loadCurrentExpiredOperation(target.metaGraph, cutoff, candidate.uri);
      if (isClosed() || !current || !sameExpiredOperation(current, candidate)) return undefined;
      const graphs = await resolveSharedMemoryScopeGraphs(
        this.#store,
        target.dataGraph,
        { kind: 'complete-family' },
      );
      // Remote counted-delete APIs measure graph-wide before/after counts.
      // Serialize those sequences per metadata graph after entity/KA locks so
      // an unrelated writer is never held behind an entire cleanup page.
      return withCountedStoreMutation(this.#store, target.metaGraph, async () => {
        if (isClosed()) return undefined;
        return this.#deleteCurrentOperation(target, graphs, current);
      });
    });
  }

  #writeLockKeys(
    target: SharedMemoryScopeDescriptor,
    operation: SharedMemoryExpiredOperation,
  ): string[] {
    return [
      ...operation.roots.map((root) => swmEntityWriteLockKey(
        target.contextGraphId,
        target.subGraphName,
        root,
      )),
      ...(operation.scope.kind === 'graph-v2' && operation.scope.kaUal
        ? [swmKaWriteLockKey(target.contextGraphId, target.subGraphName, operation.scope.kaUal)]
        : []),
    ];
  }

  async #loadCurrentExpiredOperation(
    metaGraph: string,
    cutoff: string,
    uri: string,
  ): Promise<SharedMemoryExpiredOperation | undefined> {
    if (!isSafeIri(uri)) return undefined;
    const result = await this.#store.query(`SELECT ?op ?re ?scopeVersion ?kaUal ?snapshotGraph WHERE {
      { SELECT DISTINCT ?op WHERE {
        GRAPH <${metaGraph}> {
          VALUES ?op { <${uri}> }
          ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> .
          ?op <http://dkg.io/ontology/publishedAt> ?ts .
          FILTER(?ts < "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
        }
      } }
      GRAPH <${metaGraph}> {
        OPTIONAL { ?op <http://dkg.io/ontology/rootEntity> ?re }
        OPTIONAL {
          ?op <http://dkg.io/ontology/contentScopeVersion> ?scopeVersion .
          OPTIONAL { ?op <http://dkg.io/ontology/kaUal> ?kaUal }
          OPTIONAL { ?op <http://dkg.io/ontology/publicSnapshotGraph> ?snapshotGraph }
        }
      }
    }`, { source: 'publisher.swmExpiry.revalidateOperation' });
    return decodeSharedMemoryExpiredOperations(result)[0];
  }

  async #deleteCurrentOperation(
    target: SharedMemoryScopeDescriptor,
    graphs: readonly string[],
    operation: SharedMemoryExpiredOperation,
  ): Promise<SharedMemoryExpiryMutationOutcome> {
    let triplesDeleted = await this.#deleteLegacyRoots(graphs, operation.roots);
    if (operation.scope.kind === 'graph-v2') {
      triplesDeleted += await this.#deleteGraphScopedOperation(
        target.metaGraph,
        operation.uri,
        operation.scope,
      );
    }
    for (const root of operation.roots) {
      triplesDeleted += await this.#store.deleteByPattern({
        graph: target.metaGraph,
        subject: root,
        predicate: 'http://dkg.io/ontology/workspaceOwner',
      });
      this.#ownedEntities.get(target.ownershipKey)?.delete(root);
    }
    // The operation marker is the persistent retry cursor. Remove it only
    // after every owner triple and cache entry has been retired successfully.
    triplesDeleted += await this.#store.deleteByPattern({
      graph: target.metaGraph,
      subject: operation.uri,
    });
    const remaining = await this.#store.query(
      `ASK { GRAPH <${target.metaGraph}> { <${operation.uri}> ?predicate ?object } }`,
      { source: 'publisher.swmExpiry.verifyOperationDeletion' },
    );
    const operationRemoved = remaining.type === 'boolean' && remaining.value === false;
    return { triplesDeleted, operationRemoved };
  }

  async #deleteLegacyRoots(graphs: readonly string[], roots: readonly string[]): Promise<number> {
    let deleted = 0;
    for (const root of roots) {
      for (const graph of graphs) {
        deleted += await this.#store.deleteByPattern({ graph, subject: root });
        deleted += await this.#store.deleteBySubjectPrefix(graph, `${root}/.well-known/genid/`);
      }
    }
    return deleted;
  }

  async #deleteGraphScopedOperation(
    metaGraph: string,
    uri: string,
    scope: Extract<SharedMemoryExpiredOperation['scope'], { kind: 'graph-v2' }>,
  ): Promise<number> {
    let deleted = 0;
    const head = scope.kaUal ? `${scope.kaUal}#dkg-swm-head` : '';
    if (head && isSafeIri(head)) {
      // A newer operation owns its live head/assertion graph independently of
      // this expiry. Only the operation that still owns the head may remove it.
      const owner = await this.#store.query(`SELECT ?assertionGraph WHERE {
        GRAPH <${metaGraph}> {
          <${uri}> <http://dkg.io/ontology/shareOperationId> ?opId .
          <${head}> <http://dkg.io/ontology/shareOperationId> ?opId .
          OPTIONAL { <${head}> <http://dkg.io/ontology/assertionGraph> ?assertionGraph }
        }
      } LIMIT 1`, { source: 'publisher.swmExpiry.currentHeadOwner' });
      if (owner.type === 'bindings' && owner.bindings.length > 0) {
        const graph = owner.bindings[0]?.assertionGraph;
        if (graph && isSafeIri(graph)) {
          deleted += await this.#store.deleteByPattern({ graph });
          await this.#store.dropGraph(graph);
        }
        deleted += await this.#store.deleteByPattern({ graph: metaGraph, subject: head });
      }
    }
    if (scope.snapshotGraph && isSafeIri(scope.snapshotGraph)) {
      deleted += await this.#store.deleteByPattern({ graph: scope.snapshotGraph });
      await this.#store.dropGraph(scope.snapshotGraph);
    }
    return deleted;
  }
}

function sameExpiredOperation(
  left: SharedMemoryExpiredOperation,
  right: SharedMemoryExpiredOperation,
): boolean {
  if (left.uri !== right.uri || left.scope.kind !== right.scope.kind) return false;
  const leftRoots = [...left.roots].sort();
  const rightRoots = [...right.roots].sort();
  if (leftRoots.length !== rightRoots.length
    || leftRoots.some((root, index) => root !== rightRoots[index])) return false;
  return left.scope.kind === 'legacy' || (
    right.scope.kind === 'graph-v2'
    && left.scope.kaUal === right.scope.kaUal
    && left.scope.snapshotGraph === right.scope.snapshotGraph
  );
}
