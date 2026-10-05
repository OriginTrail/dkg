// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, contextGraphSharedMemoryMetaUri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { draftOperationReferenceKey, markDraftOperationRetired, readDraftArtifactReferences, swmKaWriteLockKey, swmEntityWriteLockKey, withKeyedLocks, workspaceOperationSubject, withWorkspaceOperationWriteLock } from '@origintrail-official/dkg-publisher';
import { stripMetadataLiteral as literal } from '../../sync/metadata-literal.js';

export type DraftArtifactReferences = NonNullable<Awaited<ReturnType<typeof readDraftArtifactReferences>>>;
const DKG = 'http://dkg.io/ontology/';
export interface DraftOperationRetirementContext {
  readonly id: string;
  readonly metaGraph: string;
  readonly kaUal?: string;
}
interface RetirementOwnership extends DraftOperationRetirementContext { readonly keys: string[] }

/** Resolve the actual writer's complete lock domain, retaining incomplete metadata. */
async function readRetirementOwnership(
  store: TripleStore, contextGraphId: string, subGraphName: string | undefined, operationSubject: string,
): Promise<RetirementOwnership | null> {
  const meta = contextGraphSharedMemoryMetaUri(contextGraphId, subGraphName);
  const rows = await store.query(`SELECT ?id ?ka ?scope WHERE { GRAPH <${assertSafeIri(meta)}> {
    <${assertSafeIri(operationSubject)}> <${DKG}shareOperationId> ?id
    OPTIONAL { <${operationSubject}> <${DKG}kaUal> ?ka }
    OPTIONAL { <${operationSubject}> <${DKG}contentScopeVersion> ?scope }
  } } LIMIT 2`, { source: 'agent.draftArtifacts.ttlOperationReference', priority: 'background' });
  if (rows.type !== 'bindings' || rows.bindings.length !== 1 || !rows.bindings[0]?.['id']) return null;
  const row = rows.bindings[0]!;
  const id = literal(row['id']!);
  if (workspaceOperationSubject(contextGraphId, id) !== operationSubject) return null;
  if (row['ka']) return { id, metaGraph: meta, kaUal: row['ka'], keys: [swmKaWriteLockKey(contextGraphId, subGraphName, row['ka'])] };
  // Legacy entity shares deliberately have no KA identity or scope marker.
  // Explicit graph scope without a KA remains incomplete and is retained.
  if (row['scope'] !== undefined) return null;
  const roots = await store.query(`SELECT DISTINCT ?root WHERE { GRAPH <${meta}> {
    <${operationSubject}> <${DKG}rootEntity> ?root
  } }`, { source: 'agent.draftArtifacts.ttlLegacyEntityOwnership', priority: 'background' });
  if (roots.type !== 'bindings' || roots.bindings.length === 0 || roots.bindings.some(root => !root['root'])) return null;
  return { id, metaGraph: meta, keys: roots.bindings.map(root => swmEntityWriteLockKey(contextGraphId, subGraphName, root['root']!)).sort() };
}

/**
 * One retirement protocol under the caller's collection/admission lease and
 * immutable queue references. Eligibility remains a lane policy; every lane
 * acquires and revalidates the actual writer then operation identity domain,
 * rechecks its cutoff, and tombstones before any deletion effects.
 * Queue I/O fencing ends before this boundary acquires writer locks.
 */
export async function collectUnreferencedDraftOperation(input: {
  store: TripleStore;
  references: DraftArtifactReferences;
  contextGraphId: string;
  subGraphName?: string;
  operationSubject: string;
  now: number;
  writeLocks: Map<string, Promise<void>>;
  cutoffMs: number;
  mayRetire: (owner: DraftOperationRetirementContext) => Promise<boolean>;
  collect: () => Promise<void>;
}): Promise<void> {
  const { store, references, contextGraphId, subGraphName, operationSubject } = input;
  if (references.rawNamespaces.has(JSON.stringify([contextGraphId, subGraphName ?? '']))) return;
  const selected = await readRetirementOwnership(store, contextGraphId, subGraphName, operationSubject);
  if (!selected) return;
  const { id, keys, metaGraph: meta } = selected;
  if (references.operations.has(draftOperationReferenceKey(contextGraphId, subGraphName, id))) return;
  await withKeyedLocks(input.writeLocks, keys, () =>
    withWorkspaceOperationWriteLock({ store, contextGraphId, subGraphName, shareOperationId: id }, async () => {
      const currentOwner = await readRetirementOwnership(store, contextGraphId, subGraphName, operationSubject);
      if (!currentOwner || currentOwner.id !== id || currentOwner.kaUal !== selected.kaUal
        || currentOwner.keys.length !== keys.length || currentOwner.keys.some((key, index) => key !== keys[index])) return;
      const current = await store.query(`SELECT ?at WHERE { GRAPH <${meta}> { <${operationSubject}> <${DKG}publishedAt> ?at } }`, { source: 'agent.draftArtifacts.ttlCurrentExpiry', priority: 'background' });
      if (current.type !== 'bindings' || current.bindings.length === 0
        || current.bindings.some(row => !row['at'] || !Number.isFinite(Date.parse(literal(row['at']))) || Date.parse(literal(row['at'])) >= input.cutoffMs)) return;
      if (!await input.mayRetire(currentOwner)) return;
      await markDraftOperationRetired(store, contextGraphId, subGraphName, id, input.now);
      await input.collect();
    }));
}
