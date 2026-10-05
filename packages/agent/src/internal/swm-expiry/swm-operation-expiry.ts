// SPDX-License-Identifier: Apache-2.0
import { GRAPH_KA_CONTENT_SCOPE_VERSION, assertSafeIri, contextGraphMetaUri, contextGraphSharedMemoryMetaUri, contextGraphSharedMemoryUri, sparqlString } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { STORAGE_ACK_LEDGER_GRAPH, draftOperationReferenceKey, readDraftArtifactReferences, withDraftArtifactCollection, workspaceOperationSubject } from '@origintrail-official/dkg-publisher';
import { stripMetadataLiteral as literal } from '../../sync/metadata-literal.js';
import { storageAckNotRetainedFilters } from '../../storage-ack-retention.js';
import { expiredSwmOperationMayRetire, readExpiredSwmOperationBatch } from './swm-expiry-batch.js';

import { collectUnreferencedDraftOperation, type DraftArtifactReferences } from '../draft/draft-operation-retirement.js';
const DKG = 'http://dkg.io/ontology/';
const BATCH_SIZE = 32;
/** Complete TTL policy under the actual writer and operation identity locks. */
export interface DraftOperationRetirementPolicy {
  readonly writeLocks: Map<string, Promise<void>>;
  readonly cutoffMs: number;
  readonly mayRetire: (operationSubject: string) => Promise<boolean>;
}
/** The older TTL lane uses the same admission fence and immutable queue references. */
async function collectUnqueuedDraftOperation(
  store: TripleStore,
  references: DraftArtifactReferences,
  contextGraphId: string,
  subGraphName: string | undefined,
  operationSubject: string,
  now: number,
  collect: () => Promise<void>,
  ownership: DraftOperationRetirementPolicy,
): Promise<void> {
  await collectUnreferencedDraftOperation({
    store, references, contextGraphId, subGraphName, operationSubject, now,
    writeLocks: ownership.writeLocks, cutoffMs: ownership.cutoffMs, collect,
    mayRetire: async ({ id, metaGraph: meta }) => {
      if (!await ownership.mayRetire(operationSubject)) return false;
      // Every pointer in the current alias class owns the same assertion.
      // A live, queued, ACK-owned, or unreadable alias keeps the entire class,
      // including the older publisher clock. This read and all TTL mutations
      // share the writer's complete lock domain; the collection fence owns queue admission.
      const aliases = await store.query(`SELECT DISTINCT ?alias ?at WHERE { GRAPH <${meta}> {
        ?head <${DKG}shareOperationId> ${sparqlString(id)} ; <${DKG}assertionGraph> ?graph ; <${DKG}shareOperationId> ?alias .
        FILTER(?alias != ${sparqlString(id)})
        OPTIONAL { ?op <${DKG}shareOperationId> ?alias ; <${DKG}publishedAt> ?at }
      } }`, { source: 'agent.draftArtifacts.ttlHeadAliases', priority: 'background' });
      if (aliases.type !== 'bindings') return false;
      for (const row of aliases.bindings) {
        if (!row['alias'] || !row['at']) return false;
        const alias = literal(row['alias']);
        const at = Date.parse(literal(row['at']));
        if (!Number.isFinite(at) || at >= ownership.cutoffMs
          || references.operations.has(draftOperationReferenceKey(contextGraphId, subGraphName, alias))) return false;
        const aliasSubject = workspaceOperationSubject(contextGraphId, alias);
        if (!await ownership.mayRetire(aliasSubject)) return false;
      }
      return true;
    },
  });
}

export interface DraftOperationCollectionSession {
  withUnqueuedOperation: (
    contextGraphId: string, subGraphName: string | undefined, operationSubject: string,
    now: number, collect: () => Promise<void>,
    ownership: DraftOperationRetirementPolicy,
  ) => Promise<void>;
}

/** One immutable queue snapshot per bounded chunk, with admission between chunks. */
export async function withDraftOperationCollectionBatches<T>(
  store: TripleStore, items: readonly T[], collect: (item: T, session: DraftOperationCollectionSession) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    await withDraftArtifactCollection(store, async () => {
      const references = await readDraftArtifactReferences(store);
      if (!references) return;
      const session: DraftOperationCollectionSession = {
        withUnqueuedOperation: (...args) => collectUnqueuedDraftOperation(store, references, ...args),
      };
      for (const item of items.slice(offset, offset + BATCH_SIZE)) await collect(item, session);
    });
  }
}

/** Single-operation entry using the same complete TTL ownership policy. */
export async function withUnqueuedDraftOperation(
  store: TripleStore, contextGraphId: string, subGraphName: string | undefined,
  operationSubject: string, now: number, collect: () => Promise<void>,
  ownership: DraftOperationRetirementPolicy,
): Promise<void> {
  await withDraftOperationCollectionBatches(store, [operationSubject], async (subject, session) => {
    await session.withUnqueuedOperation(contextGraphId, subGraphName, subject, now, collect, ownership);
  });
}

export interface SharedMemoryScopeExpiryInput {
  store: TripleStore;
  writeLocks: Map<string, Promise<void>>;
  contextGraphId: string;
  subGraphName?: string;
  now: number;
  ttlMs: number;
  retentionCutoffIso: string;
  ledgerReady: boolean;
  batchSize: number;
}

/** One ownership boundary for admission, expiry/ACK checks and all deletion effects. */
export async function expireSharedMemoryScope(input: SharedMemoryScopeExpiryInput): Promise<{
  deletedTriples: number; expiredOperations: number; retiredEntities: string[];
}> {
  const { store, contextGraphId, subGraphName, now } = input;
  const meta = contextGraphSharedMemoryMetaUri(contextGraphId, subGraphName);
  const bucket = contextGraphSharedMemoryUri(contextGraphId, subGraphName);
  const cutoff = new Date(now - input.ttlMs).toISOString();
  const retentionFilters = (suffix: string) => storageAckNotRetainedFilters({
    rootMetaGraph: contextGraphMetaUri(contextGraphId), metaGraph: meta,
    binding: '', opVar: '?op', tsVar: '?ts', retentionCutoffIso: input.retentionCutoffIso,
    suffix, ledgerReady: input.ledgerReady,
  });
  const result = { deletedTriples: 0, expiredOperations: 0, retiredEntities: [] as string[] };
  let cursor = '';
  for (;;) {
    const expired = await readExpiredSwmOperationBatch(store, {
      metaGraph: meta, cutoff, afterOperation: cursor,
      retentionFilters: retentionFilters('Expired'), limit: input.batchSize,
    });
    if (expired.type !== 'bindings' || expired.bindings.length === 0) break;
    const nextCursor = expired.bindings.at(-1)?.['op'];
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    await withDraftOperationCollectionBatches(store, expired.bindings, async (row, collection) => {
      const operation = row['op'];
      if (!operation) return;
      await collection.withUnqueuedOperation(contextGraphId, subGraphName, operation, now, async () => {
        const roots = await store.query(`SELECT ?re WHERE { GRAPH <${meta}> {
          <${operation}> <${DKG}rootEntity> ?re
        } }`, { source: 'agent.swmCleanup.operationRoots' });
        const rootEntities = roots.type === 'bindings' ? roots.bindings.flatMap(root => root['re'] ? [root['re']] : []) : [];
        // Entity ownership covers only the legacy bucket. Per-KA graphs may
        // contain the same RDF subjects under independent KA write locks.
        for (const root of rootEntities) {
          result.deletedTriples += await store.deleteByPattern({ graph: bucket, subject: root });
          result.deletedTriples += await store.deleteBySubjectPrefix(bucket, `${root}/.well-known/genid/`);
        }
        const metadata = await store.query(`SELECT ?scopeVersion ?kaUal ?snapshotGraph WHERE {
          GRAPH <${meta}> {
            <${operation}> <${DKG}contentScopeVersion> ?scopeVersion .
            OPTIONAL { <${operation}> <${DKG}kaUal> ?kaUal }
            OPTIONAL { <${operation}> <${DKG}publicSnapshotGraph> ?snapshotGraph }
          }
        } LIMIT 1`, { source: 'agent.swmCleanup.graphScopedMetadata' });
        const identity = metadata.type === 'bindings' ? metadata.bindings[0] : undefined;
        if (identity?.['scopeVersion'] !== undefined && Number(literal(identity['scopeVersion'])) === GRAPH_KA_CONTENT_SCOPE_VERSION) {
          const ka = identity['kaUal'];
          if (ka) {
            const head = `${ka}#dkg-swm-head`;
            // The complete alias class was already certified under this KA
            // lock. Tear down only a head that still references this operation.
            const owned = await store.query(`SELECT ?assertionGraph WHERE { GRAPH <${meta}> {
              <${operation}> <${DKG}shareOperationId> ?id .
              <${assertSafeIri(head)}> <${DKG}shareOperationId> ?id .
              OPTIONAL { <${head}> <${DKG}assertionGraph> ?assertionGraph }
            } } LIMIT 1`, { source: 'agent.swmCleanup.currentHeadOwner' });
            if (owned.type === 'bindings' && owned.bindings.length > 0) {
              const graph = owned.bindings[0]?.['assertionGraph'];
              if (graph) {
                assertSafeIri(graph);
                result.deletedTriples += await store.deleteByPattern({ graph });
                await store.dropGraph(graph);
              }
              result.deletedTriples += await store.deleteByPattern({ graph: meta, subject: head });
            }
          }
          const snapshot = identity['snapshotGraph'];
          if (snapshot) {
            assertSafeIri(snapshot);
            result.deletedTriples += await store.deleteByPattern({ graph: snapshot });
            await store.dropGraph(snapshot);
          }
        }
        const removed = await store.deleteByPattern({ graph: meta, subject: operation });
        result.deletedTriples += removed;
        if (removed > 0) result.expiredOperations += 1;
        await store.deleteByPattern({ graph: STORAGE_ACK_LEDGER_GRAPH, subject: operation });
        for (const root of rootEntities) result.deletedTriples += await store.deleteByPattern({ graph: meta, subject: root, predicate: `${DKG}workspaceOwner` });
        result.retiredEntities.push(...rootEntities);
      }, { writeLocks: input.writeLocks, cutoffMs: now - input.ttlMs,
        mayRetire: operationSubject => expiredSwmOperationMayRetire(store, {
          metaGraph: meta, operationSubject, cutoff, retentionFilters: retentionFilters('Recheck'),
        }) });
    });
  }
  return result;
}
