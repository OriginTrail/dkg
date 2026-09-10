// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKG_ONTOLOGY, contextGraphSharedMemoryMetaUri, contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';
import { FileWorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { GraphManager, OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { storeWorkspaceOperationPublicQuads } from '../../publisher/src/workspace-resolution.js';
import { DKGAgent } from '../src/index.js';
import { getSyncCheckpointKey, type SyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import type { SharedMemorySyncContext } from '../src/sync/requester/shared-memory-sync.js';
import { canonicalQuadKey } from '../src/sync/requester/quad-key.js';

const agents: DKGAgent[] = [];
const stores: TripleStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

interface Internals {
  store: TripleStore;
  syncCheckpoints: SyncCheckpointStore;
  fetchSyncPages: SharedMemorySyncContext['fetchSyncPages'];
}
async function readGraph(store: TripleStore, graph: string): Promise<Quad[]> {
  const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  if (result.type !== 'bindings') throw new Error('Expected graph rows');
  return result.bindings.map(row => ({ subject: row.s, predicate: row.p, object: row.o, graph }));
}

it.each([undefined, 'research'])('retains complete ordinary metadata across split subjects and dependencies in subgraph %s', async subGraphName => {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-swm-meta-pages-')); directories.push(directory);
  const sourceSnapshots = new FileWorkspacePublicSnapshotStore(join(directory, 'source'), undefined, { gc: { enabled: false } });
  const targetSnapshots = new FileWorkspacePublicSnapshotStore(join(directory, 'target'), undefined, { gc: { enabled: false } });
  const source = new OxigraphStore(); stores.push(source);
  const cg = 'ordinary-meta-pages';
  const peer = 'peer-source';
  const root = 'urn:ordinary:root';
  const ws = contextGraphSharedMemoryUri(cg, subGraphName);
  const meta = contextGraphSharedMemoryMetaUri(cg, subGraphName);
  const data: Quad[] = [{ subject: root, predicate: 'urn:value', object: '"retained"', graph: ws }];
  await storeWorkspaceOperationPublicQuads({
    store: source, graphManager: new GraphManager(source), contextGraphId: cg, subGraphName,
    shareOperationId: 'page-operation', rootEntities: [root], quads: data,
    publisherPeerId: peer, timestamp: new Date(), publicSnapshotStore: sourceSnapshots,
  });
  const metadata = (await readGraph(source, meta)).sort((a, b) => canonicalQuadKey(a).localeCompare(canonicalQuadKey(b)));
  const slice = metadata.find(row => row.subject.startsWith('urn:dkg:public-stage:'))!;
  const operation = metadata.find(row => row.subject.startsWith('urn:dkg:share:'))!;
  const forged = [
    ...metadata.filter(row => row.subject === slice.subject)
      .map(row => ({ ...row, subject: 'urn:dkg:public-stage:arbitrary' })),
    { subject: slice.subject, predicate: 'http://dkg.io/ontology/workspaceOwner', object: '"attacker"', graph: meta },
  ];
  const incomingMetadata = [...metadata, ...forged]
    .sort((a, b) => canonicalQuadKey(a).localeCompare(canonicalQuadKey(b)));
  const agent = await DKGAgent.create({
    name: 'ordinary-meta-continuation', listenPort: 0, chainAdapter: new MockChainAdapter(), publicSnapshotStore: targetSnapshots,
    rfc64CatalogActivation: { enabled: false },
  }); agents.push(agent);
  const internals = agent as unknown as Internals;
  const cgUri = `did:dkg:context-graph:${cg}`;
  await internals.store.insert([
    { subject: cgUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: `${cgUri}/_meta` },
    { subject: cgUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"public"', graph: `${cgUri}/_meta` },
  ]);
  await agent.start();
  agent.subscribeToContextGraph(cg, { persist: false, deferSharedMemoryGossipSubscribe: true });
  await agent.reconcileRfc64CatalogResponsibilityV1(cg);
  expect(agent.resolveRfc64CatalogReceiverAuthorityV1(cg).legacySyncAllowed).toBe(true);
  if (subGraphName) {
    const subject = `did:dkg:context-graph:${cg}/${subGraphName}`;
    const graph = `did:dkg:context-graph:${cg}/_meta`;
    await internals.store.insert([
      { subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph },
      { subject, predicate: 'http://schema.org/name', object: `"${subGraphName}"`, graph },
      { subject, predicate: 'http://dkg.io/ontology/createdBy', object: '"peer-source"', graph },
    ]);
  }
  const metaOffsets: number[] = [];
  const metaScopes: Array<string | undefined> = [];
  let snapshotFetches = 0;
  let dataFetches = 0;
  const pageSize = 2;
  const sliceStart = incomingMetadata.indexOf(slice);
  const operationStart = incomingMetadata.indexOf(operation);
  const operationEnd = incomingMetadata.length - 1 - [...incomingMetadata].reverse().findIndex(row => row.subject === operation.subject);
  // Exercise both a dependency in an earlier invocation and an operation
  // envelope whose fields cannot fit in one invocation.
  expect(Math.floor(sliceStart / pageSize)).toBeLessThan(Math.floor(operationStart / pageSize));
  expect(Math.floor(operationStart / pageSize)).toBeLessThan(Math.floor(operationEnd / pageSize));
  vi.spyOn(internals, 'fetchSyncPages').mockImplementation(async (_ctx, remotePeer, contextGraphId, shared, phase, _graph, _deadline, options) => {
    const checkpointKey = getSyncCheckpointKey(remotePeer, contextGraphId, shared, phase,
      undefined, undefined, undefined, undefined, options?.requesterScope);
    if (phase === 'meta') {
      const offset = internals.syncCheckpoints.get(checkpointKey)?.offset ?? 0;
      metaOffsets.push(offset);
      metaScopes.push(options?.requesterScope);
      const quads = incomingMetadata.slice(offset, offset + pageSize);
      const nextOffset = offset + quads.length;
      return { quads, bytesReceived: quads.length, resumedFromOffset: offset, nextOffset, checkpointKey,
        completed: nextOffset === incomingMetadata.length, timedOut: nextOffset < incomingMetadata.length };
    }
    if (phase === 'snapshot') {
      snapshotFetches++;
      const quads = await sourceSnapshots.getSnapshot(options!.snapshotRef!);
      if (!quads) throw new Error('Requested unknown snapshot');
      return { quads, bytesReceived: 1, resumedFromOffset: 0, nextOffset: quads.length, checkpointKey, completed: true, timedOut: false };
    }
    dataFetches++;
    return { quads: data, bytesReceived: 1, resumedFromOffset: 0, nextOffset: data.length, checkpointKey, completed: true, timedOut: false };
  });
  const rounds = Math.ceil(incomingMetadata.length / pageSize);
  for (let round = 0; round < rounds; round++) {
    const result = await agent.syncSharedMemoryFromPeerDetailed(peer, [cg], {
      sharedMemorySyncPlan: { targets: [{ contextGraphId: cg, lane: 'selected-public' }] },
    });
    expect(result.failedPeers).toBe(0);
  }
  expect(metaOffsets).toEqual(Array.from({ length: rounds }, (_, index) => index * pageSize));
  expect(new Set(metaScopes).size).toBe(1);
  expect.soft(metaScopes[0]).toMatch(/^ordinary-swm-meta:retained:/);
  expect.soft(dataFetches).toBe(1);
  expect.soft(snapshotFetches).toBe(1);
  expect.soft((await readGraph(internals.store, meta)).map(canonicalQuadKey).sort())
    .toEqual(metadata.map(canonicalQuadKey).sort());
  expect.soft(await readGraph(internals.store, ws)).toEqual(data);
  for (const row of forged) expect(await readGraph(internals.store, meta)).not.toContainEqual(row);
  const refQuad = metadata.find(row => row.predicate === 'http://dkg.io/ontology/publicSnapshotRef')
    ?? metadata.find(row => row.predicate === 'http://dkg.io/ontology/publicQuadsDigest');
  expect(refQuad).toBeDefined();
  const ref = refQuad!.object.replace(/^"|"$/g, '');
  expect(await targetSnapshots.getSnapshot(ref)).toEqual(await sourceSnapshots.getSnapshot(ref));
});
