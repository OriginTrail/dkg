// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { assertSafeIri, contextGraphMetaUri, resolveWithinAbort, sparqlString } from '@origintrail-official/dkg-core';
import { deleteByPatternWithoutCount, knowledgeAssetPrivateArtifactOwnerCandidates, readKnowledgeAssetPrivateArtifactsPage, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  STORAGE_ACK_LEDGER_GRAPH, draftPrivateReferenceKey,
  readDraftArtifactReferences, swmKaWriteLockKey,
  withDraftArtifactCollection, withKeyedLocks, workspaceOperationSubject,
} from '@origintrail-official/dkg-publisher';
import { stripMetadataLiteral as literal } from '../../sync/metadata-literal.js';
import { collectUnreferencedDraftOperation } from './draft-operation-retirement.js';
import { readConfirmedDraftVersion } from './confirmed-draft-version.js';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
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
  pendingAckTxWindowMs: number;
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
    const cutoff = new Date(now - input.pendingAckTxWindowMs).toISOString();
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
      if (id.startsWith('storage-ack-')) continue;
      await collectUnreferencedDraftOperation({
        store, references, contextGraphId, subGraphName, operationSubject: op, now,
        writeLocks: input.writeLocks, cutoffMs: now - input.pendingAckTxWindowMs,
        mayRetire: async owner => {
          if (owner.id !== id || owner.kaUal !== ka || owner.metaGraph !== meta) return false;
          assertSafeIri(meta); assertSafeIri(op); assertSafeIri(ka);
          // Recheck the current head under the receiver's lock, including equivalent aliases.
          if (await exists(store, `GRAPH <${meta}> { ?head <${DKG}kaUal> <${ka}> ; <${DKG}assertionGraph> ?graph ; <${DKG}shareOperationId> ${sparqlString(id)} }`)) return false;
          if (!await exists(store, `GRAPH <${meta}> { ?head <${DKG}kaUal> <${ka}> ; <${DKG}assertionGraph> ?graph ; <${DKG}shareOperationId> ?current . FILTER(?current != ${sparqlString(id)}) }`)) return false;
          if (await exists(store, `GRAPH <${meta}> {
            ?head <${DKG}kaUal> <${ka}> ; <${DKG}assertionGraph> ?graph ; <${DKG}shareOperationId> ?current .
            ?currentOp <${DKG}shareOperationId> ?current ; <${DKG}assertionVersion> ?version ; <${DKG}publicQuadsDigest> ?digest .
            <${op}> <${DKG}assertionVersion> ?version ; <${DKG}publicQuadsDigest> ?digest .
          }`)) return false;
          if (await exists(store, `GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> { <${op}> ?p ?o }`)) return false;
          if (await exists(store, `GRAPH <${rootMeta}> { ?descriptor <${DKG}currentShareOperationId> ${sparqlString(id)} }`)) return false;
          return true;
        },
        collect: async () => {
          // Private collection below also requires proof that the version was burned.
          await deleteByPatternWithoutCount(store, { graph: meta, subject: op });
          const snapshot = row['snapshot'];
          if (snapshot && !await exists(store, `GRAPH ?g { ?owner <${DKG}publicSnapshotGraph> <${assertSafeIri(snapshot)}> }`)) await store.dropGraph(snapshot);
          counts.operations += 1;
        },
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
        // An unavailable private-version RPC retains this artifact without
        // blocking independent SWM TTL expiry. Cancellation still belongs to
        // the caller; storage/reference/deletion errors stay outside this boundary.
        const current = await resolveWithinAbort(() => readConfirmedDraftVersion(chain, ka), chainDeadline).catch((error: unknown) => {
          if (error !== null && typeof error === 'object'
            && (('name' in error && error.name === 'AbortError')
              || ('code' in error && error.code === 'ABORT_ERR'))) throw error;
          return null;
        });
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
