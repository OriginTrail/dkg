// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { assertSafeIri, contextGraphMetaUri, resolveWithinAbort, sparqlString } from '@origintrail-official/dkg-core';
import { deleteByPatternWithoutCount, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  STORAGE_ACK_LEDGER_GRAPH, draftOperationReferenceKey, draftPrivateReferenceKey,
  markDraftOperationRetired, readDraftArtifactReferences, swmKaWriteLockKey,
  withDraftArtifactReferences, withKeyedLocks,
} from '@origintrail-official/dkg-publisher';
import { readConfirmedDraftVersion } from './confirmed-draft-version.js';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ACK_WINDOW_MS = 5 * 60_000;
const BATCH_SIZE = 32;
const cursors = new WeakMap<TripleStore, Map<string, { operation: string; privateGraph: string }>>();

function literal(value: string): string {
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  return match ? JSON.parse(`"${match[1]}"`) as string : value;
}
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
  return withDraftArtifactReferences(input.store, async () => {
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
    const graphs = await store.query(`SELECT DISTINCT ?graph WHERE {
      GRAPH ?graph { ?s ?p ?o }
      FILTER(STRSTARTS(STR(?graph), ${sparqlString(prefix)}) && CONTAINS(STR(?graph), "/_private/"))
      FILTER(STR(?graph) > ${sparqlString(cursor.privateGraph)})
    } ORDER BY ?graph LIMIT ${BATCH_SIZE}`, { source: 'agent.draftArtifacts.privateGraphs', priority: 'background' });
    if (graphs.type !== 'bindings') return counts;
    cursor.privateGraph = graphs.bindings.length === BATCH_SIZE ? graphs.bindings.at(-1)?.['graph'] ?? '' : '';
    const chainDeadline = AbortSignal.timeout(2_000);
    for (const row of graphs.bindings) {
      const graph = row['graph']; if (!graph) continue;
      const relative = graph.slice(prefix.length);
      const parsed = /^(?:(?<sub>[^/]+)\/)?_private\/(?<author>0x[0-9a-fA-F]{40})\/(?<number>[1-9][0-9]*)\/assertions\/(?<version>[1-9][0-9]*)(?:\/commitments\/[0-9a-fA-F]{64})?$/.exec(relative);
      const parts = parsed?.groups; if (!parts) continue;
      const sub = parts['sub']; const author = parts['author']!; const number = parts['number']!; const version = parts['version']!;
      if (references.rawNamespaces.has(JSON.stringify([contextGraphId, sub ?? '']))
        || references.privateVersions.has(draftPrivateReferenceKey(contextGraphId, sub, author, number, version))) continue;
      await withKeyedLocks(input.writeLocks, [swmKaWriteLockKey(contextGraphId, sub, `did:dkg:${chain.chainId}/${author}/${number}`)], async () => {
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
export async function withUnqueuedDraftOperation(
  store: TripleStore,
  contextGraphId: string,
  subGraphName: string | undefined,
  operationSubject: string,
  now: number,
  collect: () => Promise<void>,
): Promise<void> {
  return withDraftArtifactReferences(store, async () => {
    const references = await readDraftArtifactReferences(store);
    if (!references || references.rawNamespaces.has(JSON.stringify([contextGraphId, subGraphName ?? '']))) return;
    const meta = `did:dkg:context-graph:${contextGraphId}/${subGraphName ? `${subGraphName}/` : ''}_shared_memory_meta`;
    const rows = await store.query(`SELECT ?id WHERE { GRAPH <${assertSafeIri(meta)}> {
      <${assertSafeIri(operationSubject)}> <${DKG}shareOperationId> ?id
    } } LIMIT 2`, { source: 'agent.draftArtifacts.ttlOperationReference', priority: 'background' });
    if (rows.type !== 'bindings' || rows.bindings.length !== 1 || !rows.bindings[0]?.['id']) return;
    const id = literal(rows.bindings[0]['id']);
    if (references.operations.has(draftOperationReferenceKey(contextGraphId, subGraphName, id))) return;
    await markDraftOperationRetired(store, contextGraphId, subGraphName, id, now);
    await collect();
  });
}
