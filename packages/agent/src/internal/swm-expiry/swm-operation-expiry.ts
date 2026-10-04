// SPDX-License-Identifier: Apache-2.0
import { GRAPH_KA_CONTENT_SCOPE_VERSION, assertSafeIri, contextGraphMetaUri, sparqlString } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { STORAGE_ACK_LEDGER_GRAPH, draftOperationReferenceKey, markDraftOperationRetired, readDraftArtifactReferences, swmKaWriteLockKey, swmEntityWriteLockKey, withDraftArtifactCollection, withKeyedLocks, workspaceOperationSubject, withWorkspaceOperationWriteLock } from '@origintrail-official/dkg-publisher';
import { stripMetadataLiteral as literal } from '../../sync/metadata-literal.js';
import { storageAckNotRetainedFilters } from '../../storage-ack-retention.js';
import { expiredSwmOperationMayRetire, readExpiredSwmOperationBatch } from './swm-expiry-batch.js';

type DraftArtifactReferences = NonNullable<Awaited<ReturnType<typeof readDraftArtifactReferences>>>;
const DKG = 'http://dkg.io/ontology/';
const BATCH_SIZE = 32;
/** Complete TTL policy under the actual writer and operation identity locks. */
export interface DraftOperationRetirementPolicy {
  readonly writeLocks: Map<string, Promise<void>>;
  readonly cutoffMs: number;
  readonly mayRetire: (operationSubject: string) => Promise<boolean>;
}
/** Resolve the actual writer's complete lock domain, retaining incomplete metadata. */
async function readRetirementOwnership(
  store: TripleStore, contextGraphId: string, subGraphName: string | undefined, operationSubject: string,
): Promise<{ id: string; keys: string[] } | null> {
  const meta = `did:dkg:context-graph:${contextGraphId}/${subGraphName ? `${subGraphName}/` : ''}_shared_memory_meta`;
  const rows = await store.query(`SELECT ?id ?ka ?scope WHERE { GRAPH <${assertSafeIri(meta)}> {
    <${assertSafeIri(operationSubject)}> <${DKG}shareOperationId> ?id
    OPTIONAL { <${operationSubject}> <${DKG}kaUal> ?ka }
    OPTIONAL { <${operationSubject}> <${DKG}contentScopeVersion> ?scope }
  } } LIMIT 2`, { source: 'agent.draftArtifacts.ttlOperationReference', priority: 'background' });
  if (rows.type !== 'bindings' || rows.bindings.length !== 1 || !rows.bindings[0]?.['id']) return null;
  const row = rows.bindings[0]!;
  const id = literal(row['id']!);
  if (workspaceOperationSubject(contextGraphId, id) !== operationSubject) return null;
  if (row['ka']) return { id, keys: [swmKaWriteLockKey(contextGraphId, subGraphName, row['ka'])] };
  // Legacy entity shares deliberately have no KA identity or scope marker.
  // Explicit graph scope without a KA remains incomplete and is retained.
  if (row['scope'] !== undefined) return null;
  const roots = await store.query(`SELECT DISTINCT ?root WHERE { GRAPH <${meta}> {
    <${operationSubject}> <${DKG}rootEntity> ?root
  } }`, { source: 'agent.draftArtifacts.ttlLegacyEntityOwnership', priority: 'background' });
  if (roots.type !== 'bindings' || roots.bindings.length === 0 || roots.bindings.some(root => !root['root'])) return null;
  return { id, keys: roots.bindings.map(root => swmEntityWriteLockKey(contextGraphId, subGraphName, root['root']!)).sort() };
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
  if (references.rawNamespaces.has(JSON.stringify([contextGraphId, subGraphName ?? '']))) return;
  const meta = `did:dkg:context-graph:${contextGraphId}/${subGraphName ? `${subGraphName}/` : ''}_shared_memory_meta`;
  const selected = await readRetirementOwnership(store, contextGraphId, subGraphName, operationSubject);
  if (!selected) return;
  const { id, keys } = selected;
  if (references.operations.has(draftOperationReferenceKey(contextGraphId, subGraphName, id))) return;
  const retire = async () => {
    const currentOwner = await readRetirementOwnership(store, contextGraphId, subGraphName, operationSubject);
    if (!currentOwner || currentOwner.id !== id || currentOwner.keys.length !== keys.length
      || currentOwner.keys.some((key, index) => key !== keys[index])) return;
    const current = await store.query(`SELECT ?at WHERE { GRAPH <${meta}> { <${operationSubject}> <${DKG}publishedAt> ?at } }`, { source: 'agent.draftArtifacts.ttlCurrentExpiry', priority: 'background' });
    if (current.type !== 'bindings' || current.bindings.length === 0
      || current.bindings.some(row => !row['at'] || !Number.isFinite(Date.parse(literal(row['at']))) || Date.parse(literal(row['at'])) >= ownership.cutoffMs)) return;
    if (!await ownership.mayRetire(operationSubject)) return;
    // Every pointer in the current alias class owns the same assertion.
    // A live, queued, ACK-owned, or unreadable alias keeps the entire class,
    // including the older publisher clock. This read and all TTL mutations
    // share the writer's complete lock domain; the collection fence owns queue admission.
    const aliases = await store.query(`SELECT DISTINCT ?alias ?at WHERE { GRAPH <${meta}> {
      ?head <${DKG}shareOperationId> ${sparqlString(id)} ; <${DKG}assertionGraph> ?graph ; <${DKG}shareOperationId> ?alias .
      FILTER(?alias != ${sparqlString(id)})
      OPTIONAL { ?op <${DKG}shareOperationId> ?alias ; <${DKG}publishedAt> ?at }
    } }`, { source: 'agent.draftArtifacts.ttlHeadAliases', priority: 'background' });
    if (aliases.type !== 'bindings') return;
    for (const row of aliases.bindings) {
      if (!row['alias'] || !row['at']) return;
      const alias = literal(row['alias']);
      const at = Date.parse(literal(row['at']));
      if (!Number.isFinite(at) || at >= ownership.cutoffMs
        || references.operations.has(draftOperationReferenceKey(contextGraphId, subGraphName, alias))) return;
      const aliasSubject = workspaceOperationSubject(contextGraphId, alias);
      if (!await ownership.mayRetire(aliasSubject)) return;
    }
    await markDraftOperationRetired(store, contextGraphId, subGraphName, id, now);
    await collect();
  };
  await withKeyedLocks(ownership.writeLocks, keys, () =>
    withWorkspaceOperationWriteLock({ store, contextGraphId, subGraphName, shareOperationId: id }, retire));
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
  const meta = `did:dkg:context-graph:${contextGraphId}/${subGraphName ? `${subGraphName}/` : ''}_shared_memory_meta`;
  const bucket = meta.slice(0, -'_meta'.length);
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
