// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { assertSafeIri, contextGraphMetaUri, resolveWithinAbort, sparqlString } from '@origintrail-official/dkg-core';
import { deleteByPatternWithoutCount, knowledgeAssetPrivateArtifactOwnerCandidates, readKnowledgeAssetPrivateArtifactsPage, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  STORAGE_ACK_LEDGER_GRAPH, draftOperationReferenceKey, draftPrivateReferenceKey,
  markDraftOperationRetired, readDraftArtifactReferences, swmKaWriteLockKey,
  withDraftArtifactCollection, withKeyedLocks, workspaceOperationSubject,
} from '@origintrail-official/dkg-publisher';
import { stripMetadataLiteral as literal } from './sync/metadata-literal.js';
import { readConfirmedDraftVersion } from './confirmed-draft-version.js';

type DraftArtifactReferences = NonNullable<Awaited<ReturnType<typeof readDraftArtifactReferences>>>;
const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ACK_WINDOW_MS = 5 * 60_000;
const BATCH_SIZE = 32;
const cursors = new WeakMap<TripleStore, Map<string, { operation: string; privateGraph: string }>>();

async function exists(store: TripleStore, query: string): Promise<boolean> {
  const result = await store.query(`ASK { ${query} }`, { source: 'agent.draftArtifacts.references', priority: 'background' });
  // A non-ASK response is unavailable reference coverage, never permission to delete.
  return result.type !== 'boolean' || result.value;
}

/** Bounded maintenance; unknown queue/chain coverage keeps every artifact. */
export async function collectAbandonedDraftArtifacts(input: {
  store: TripleStore;
  chain: ChainAdapter;
  writeLocks: Map<string, Promise<void>>;
  contextGraphId: string;
  now: number;
}): Promise<{ operations: number; privateGraphs: number }> {
  return withDraftArtifactCollection(input.store, async () => {
    const { store, chain, contextGraphId, now } = input;
    const references = await readDraftArtifactReferences(store);
    const counts = { operations: 0, privateGraphs: 0 };
    if (!references) return counts;
    let storeCursors = cursors.get(store);
    if (!storeCursors) { storeCursors = new Map(); cursors.set(store, storeCursors); }
    const cursor = storeCursors.get(contextGraphId) ?? { operation: '', privateGraph: '' };
    storeCursors.set(contextGraphId, cursor);
    const prefix = `did:dkg:context-graph:${contextGraphId}/`;
    const cutoff = new Date(now - ACK_WINDOW_MS).toISOString();
    const rootMeta = contextGraphMetaUri(contextGraphId);
    const rows = await store.query(`SELECT DISTINCT ?meta ?op ?id ?ka ?snapshot ?cursor WHERE {
      GRAPH ?meta {
        ?op <${DKG}contentScopeVersion> 2 ; <${DKG}shareOperationId> ?id ;
          <${DKG}kaUal> ?ka ; <${DKG}publishedAt> ?at .
        OPTIONAL { ?op <${DKG}publicSnapshotGraph> ?snapshot }
        ?head <${DKG}kaUal> ?ka ; <${DKG}assertionGraph> ?graph ; <${DKG}shareOperationId> ?current .
        FILTER(?current != ?id)
      }
      FILTER(STRSTARTS(STR(?meta), ${sparqlString(prefix)}) && STRENDS(STR(?meta), "/_shared_memory_meta"))
      FILTER(?at < "${cutoff}"^^<${XSD}dateTime>)
      BIND(CONCAT(STR(?meta), "|", STR(?op)) AS ?cursor)
      FILTER(?cursor > ${sparqlString(cursor.operation)})
    } ORDER BY ?cursor LIMIT ${BATCH_SIZE}`, { source: 'agent.draftArtifacts.supersededOperations', priority: 'background' });
    if (rows.type !== 'bindings') return counts;
    cursor.operation = rows.bindings.length === BATCH_SIZE ? literal(rows.bindings.at(-1)?.['cursor'] ?? '') : '';
    for (const row of rows.bindings) {
      const meta = row['meta']; const op = row['op']; const ka = row['ka'];
      if (!meta || !op || !ka || !row['id']) continue;
      const id = literal(row['id']);
      // A descendant URI can be another slash-containing CG. The canonical
      // operation subject binds its actual CG; a prefix does not grant ownership.
      if (workspaceOperationSubject(contextGraphId, id) !== op) continue;
      const rest = meta.slice(prefix.length);
      const subGraphName = rest === '_shared_memory_meta' ? undefined : rest.slice(0, -'/_shared_memory_meta'.length);
      if (id.startsWith('storage-ack-') || references.operations.has(draftOperationReferenceKey(contextGraphId, subGraphName, id))) continue;
      await withKeyedLocks(input.writeLocks, [swmKaWriteLockKey(contextGraphId, subGraphName, ka)], async () => {
        assertSafeIri(meta); assertSafeIri(op); assertSafeIri(ka);
        // Recheck the current head under the receiver's lock, including equivalent aliases.
        if (await exists(store, `GRAPH <${meta}> { ?head <${DKG}kaUal> <${ka}> ; <${DKG}assertionGraph> ?graph ; <${DKG}shareOperationId> ${sparqlString(id)} }`)) return;
        if (!await exists(store, `GRAPH <${meta}> { ?head <${DKG}kaUal> <${ka}> ; <${DKG}assertionGraph> ?graph ; <${DKG}shareOperationId> ?current . FILTER(?current != ${sparqlString(id)}) }`)) return;
        if (await exists(store, `GRAPH <${meta}> {
          ?head <${DKG}kaUal> <${ka}> ; <${DKG}assertionGraph> ?graph ; <${DKG}shareOperationId> ?current .
          ?currentOp <${DKG}shareOperationId> ?current ; <${DKG}assertionVersion> ?version ; <${DKG}publicQuadsDigest> ?digest .
          <${op}> <${DKG}assertionVersion> ?version ; <${DKG}publicQuadsDigest> ?digest .
        }`)) return;
        if (await exists(store, `GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> { <${op}> ?p ?o }`)) return;
        if (await exists(store, `GRAPH <${rootMeta}> { ?descriptor <${DKG}currentShareOperationId> ${sparqlString(id)} }`)) return;
        // Private collection below also requires proof that the version was burned.
        await markDraftOperationRetired(store, contextGraphId, subGraphName, id, now);
        await deleteByPatternWithoutCount(store, { graph: meta, subject: op });
        const snapshot = row['snapshot'];
        if (snapshot && !await exists(store, `GRAPH ?g { ?owner <${DKG}publicSnapshotGraph> <${assertSafeIri(snapshot)}> }`)) await store.dropGraph(snapshot);
        counts.operations += 1;
      });
    }
    // Old counter bugs left /assertions/N above the confirmed next version. Only
    // those unreachable versions are collected; historical and next drafts remain.
    const page = await readKnowledgeAssetPrivateArtifactsPage(store, contextGraphId, { cursor: cursor.privateGraph, limit: BATCH_SIZE });
    if (!page) return counts;
    cursor.privateGraph = page.nextCursor;
    const chainDeadline = AbortSignal.timeout(2_000);
    for (const artifact of page.artifacts) {
      const { graphUri: graph, agentAddress: author, kaNumber: number, assertionVersion: version } = artifact;
      const owners = knowledgeAssetPrivateArtifactOwnerCandidates(graph);
      if (owners.length === 0 || owners.some(owner =>
        references.rawNamespaces.has(JSON.stringify([owner.contextGraphId, owner.subGraphName ?? '']))
        || references.privateVersions.has(draftPrivateReferenceKey(owner.contextGraphId, owner.subGraphName, author, number, version)))) continue;
      await withKeyedLocks(input.writeLocks, owners.map(owner => swmKaWriteLockKey(owner.contextGraphId, owner.subGraphName, `did:dkg:${chain.chainId}/${author}/${number}`)), async () => {
        const ka = `did:dkg:${chain.chainId}/${author}/${number}`;
        const current = await resolveWithinAbort(() => readConfirmedDraftVersion(chain, ka), chainDeadline);
        if (current === null || current === undefined || BigInt(version) <= current + 1n) return;
        // Match any chain-qualified UAL for this author/number conservatively. A seal,
        // active head, ACK copy, or recovery receipt protects the entire version archive.
        if (await exists(store, `GRAPH ?g {
          ?owner <${DKG}kaUal> ?ual ; <${DKG}assertionVersion> ?version .
        } FILTER(STRENDS(LCASE(STR(?ual)), ${sparqlString(`/${author.toLowerCase()}/${number}`)}) && ?version = ${version})`)) return;
        if (await exists(store, `GRAPH ?g { ?s ?p <${assertSafeIri(graph)}> }`)) return;
        await store.dropGraph(graph);
        counts.privateGraphs += 1;
      });
    }
    return counts;
  });
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
  ownership?: { writeLocks: Map<string, Promise<void>>; cutoffMs: number; mayRetire?: () => Promise<boolean> },
): Promise<void> {
  if (references.rawNamespaces.has(JSON.stringify([contextGraphId, subGraphName ?? '']))) return;
  const meta = `did:dkg:context-graph:${contextGraphId}/${subGraphName ? `${subGraphName}/` : ''}_shared_memory_meta`;
  const rows = await store.query(`SELECT ?id ?ka WHERE { GRAPH <${assertSafeIri(meta)}> {
    <${assertSafeIri(operationSubject)}> <${DKG}shareOperationId> ?id
    OPTIONAL { <${operationSubject}> <${DKG}kaUal> ?ka }
  } } LIMIT 2`, { source: 'agent.draftArtifacts.ttlOperationReference', priority: 'background' });
  if (rows.type !== 'bindings' || rows.bindings.length !== 1 || !rows.bindings[0]?.['id']) return;
  const id = literal(rows.bindings[0]['id']);
  if (workspaceOperationSubject(contextGraphId, id) !== operationSubject) return;
  if (references.operations.has(draftOperationReferenceKey(contextGraphId, subGraphName, id))) return;
  const retire = async () => {
    if (ownership) {
      const current = await store.query(`SELECT ?at WHERE { GRAPH <${meta}> { <${operationSubject}> <${DKG}publishedAt> ?at } }`, { source: 'agent.draftArtifacts.ttlCurrentExpiry', priority: 'background' });
      if (current.type !== 'bindings' || current.bindings.length === 0
        || current.bindings.some(row => !row['at'] || !Number.isFinite(Date.parse(literal(row['at']))) || Date.parse(literal(row['at'])) >= ownership.cutoffMs)) return;
      if (ownership.mayRetire && !await ownership.mayRetire()) return;
    }
    // Every pointer in the current alias class owns the same assertion.
    // A live, queued, ACK-owned, or unreadable alias keeps the entire class,
    // including the older publisher clock. This read and all TTL mutations
    // share the receiver's KA lock; the collection fence owns queue admission.
    if (ownership) {
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
      }
    }
    await markDraftOperationRetired(store, contextGraphId, subGraphName, id, now);
    await collect();
  };
  const ka = rows.bindings[0]?.['ka'];
  if (ownership && ka) await withKeyedLocks(ownership.writeLocks, [swmKaWriteLockKey(contextGraphId, subGraphName, ka)], retire);
  else await retire();
}


export interface DraftOperationCollectionSession {
  withUnqueuedOperation: (
    contextGraphId: string, subGraphName: string | undefined, operationSubject: string,
    now: number, collect: () => Promise<void>,
    ownership?: { writeLocks: Map<string, Promise<void>>; cutoffMs: number; mayRetire?: () => Promise<boolean> },
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

/** Compatibility entry for a single collector operation. */
export async function withUnqueuedDraftOperation(
  store: TripleStore, contextGraphId: string, subGraphName: string | undefined,
  operationSubject: string, now: number, collect: () => Promise<void>,
  ownership?: { writeLocks: Map<string, Promise<void>>; cutoffMs: number; mayRetire?: () => Promise<boolean> },
): Promise<void> {
  await withDraftOperationCollectionBatches(store, [operationSubject], async (subject, session) => {
    await session.withUnqueuedOperation(contextGraphId, subGraphName, subject, now, collect, ownership);
  });
}
