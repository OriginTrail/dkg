// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, contextGraphSharedMemoryMetaUri, contextGraphSharedMemoryUri, createOperationContext, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher, FileWorkspacePublicSnapshotStore, generateOwnershipQuads, generateShareMetadata, workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';

const CG = 'protocol-root-ownership';
const META = contextGraphSharedMemoryMetaUri(CG);
const DATA = contextGraphSharedMemoryUri(CG);
const OP = `urn:dkg:share:${CG}:legacy-op`;
const PEER = 'peer-source';
const q = (subject: string, predicate: string, object: string, graph = META): Quad => ({ subject, predicate, object, graph });

describe('durable ownership of roots with protocol roles', () => {
  const stores: OxigraphStore[] = [], workers: SyncVerifyWorker[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.close();
    for (const store of stores.splice(0)) await store.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  it.each(['operation', 'head', 'public-slice', 'entity-only'] as const)(
    'sync and physical store reopen preserve the first writer of a %s-shaped root', async role => {
      const share = swmFixtures(CG).share({
        ual: 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/1',
        version: 1, operationId: 'modern-op', marker: 'modern',
      });
      const slice = `urn:dkg:public-stage:${CG}:_:legacy-op:urn%3Adata%3Aslice-member`;
      const root = role === 'operation' ? OP : role === 'head' ? share.headSubject
        : role === 'entity-only' ? 'urn:data:entity-only' : slice;
      const roots = role === 'public-slice' ? [root, 'urn:data:slice-member'] : [root];
      const legacy = generateShareMetadata({ contextGraphId: CG, shareOperationId: 'legacy-op',
        rootEntities: roots, publisherPeerId: PEER, timestamp: new Date(0) }, META)
        .map(row => role === 'entity-only' && row.predicate === 'http://dkg.io/ontology/rootEntity'
          ? { ...row, predicate: 'http://dkg.io/ontology/entity' } : row);
      const slicePayload = [q('urn:data:slice-member', 'urn:data:value', '"slice payload"', '')];
      const sliceDigest = workspacePublicQuadsDigest(slicePayload);
      const protocol = role === 'head' ? share.meta : role === 'public-slice' ? [
        q(slice, 'http://dkg.io/ontology/contextGraphId', `"${CG}"`),
        q(slice, 'http://dkg.io/ontology/shareOperationId', '"legacy-op"'),
        q(slice, 'http://dkg.io/ontology/publicSliceRootEntity', 'urn:data:slice-member'),
        q(slice, 'http://dkg.io/ontology/publicQuadsDigest', `"${sliceDigest}"`),
        q(slice, 'http://dkg.io/ontology/publicQuadsCount', '"1"'),
      ] : [];
      const owner = generateOwnershipQuads([{ rootEntity: root, creatorPeerId: PEER }], META);
      const injected = q(root, 'http://dkg.io/ontology/workspaceOwner', '"attacker"');
      const metadata = [...legacy, ...protocol, ...owner, ...(role === 'entity-only' ? [] : [injected])];
      const data = [q(root, 'urn:data:value', '"retained"', DATA)];
      const directory = await mkdtemp(join(tmpdir(), 'dkg-protocol-root-owner-'));
      directories.push(directory);
      const path = join(directory, 'store.nq');
      const store = new OxigraphStore(path); stores.push(store);
      const manager = new GraphManager(store);
      const snapshots = new FileWorkspacePublicSnapshotStore(join(directory, 'snapshots'));
      if (role === 'head') await snapshots.putSnapshot({ digest: share.digest, quads: share.payload });
      if (role === 'public-slice') await snapshots.putSnapshot({ digest: sliceDigest, quads: slicePayload });
      const worker = new SyncVerifyWorker(); workers.push(worker);
      const owned = new Map<string, string>();
      const result = await runSharedMemorySync({
        mode: { kind: 'ordinary' }, ctx: createOperationContext('sync'), remotePeerId: PEER,
        contextGraphIds: [CG], createContextGraphSyncDeadline: () => Date.now() + 30_000,
        fetchSyncPages: async (_ctx, _peer, _cg, _includeSwm, phase) => {
          const quads = phase === 'data' ? data : metadata;
          return { quads, bytesReceived: 1, resumedFromOffset: 0, nextOffset: quads.length,
            checkpointKey: phase, completed: true, timedOut: false };
        },
        publicSnapshotStore: snapshots,
        snapshotMaterializer: createSharedMemorySnapshotMaterializer({ store, writeLocks: new Map(), invalidateListContextGraphsCache: () => {} }),
        processSharedMemoryBatch: (...args) => worker.processSharedMemoryBatch(...args),
        ensureContextGraph: id => manager.ensureContextGraph(id), storeInsert: quads => store.insert(quads),
        deleteCheckpoint: () => {}, setCheckpoint: () => {}, ensureOwnedMap: () => owned,
        logInfo: () => {}, logWarn: () => {}, logDebug: () => {},
      });
      expect(result).toMatchObject({ failedPeers: 0 });
      expect(await store.query(`SELECT ?value WHERE { GRAPH <${DATA}> { <${root}> <urn:data:value> ?value } }`))
        .toEqual({ type: 'bindings', bindings: [{ value: '"retained"' }] });
      expect(owned.get(root)).toBe(PEER);
      await store.close(); stores.splice(stores.indexOf(store), 1);
      const reopened = new OxigraphStore(path); stores.push(reopened);
      const freshOwned = new Map<string, Map<string, string>>();
      const publisher = new DKGPublisher({ store: reopened, chain: new MockChainAdapter(),
        eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair(), sharedMemoryOwnedEntities: freshOwned });
      expect(await publisher.reconstructSharedMemoryOwnership()).toBe(1);
      expect(freshOwned.get(CG)?.get(root)).toBe(PEER);
      const persisted = await reopened.query(`SELECT ?owner WHERE { GRAPH <${META}> { <${root}> <http://dkg.io/ontology/workspaceOwner> ?owner } }`);
      expect(persisted).toEqual({ type: 'bindings', bindings: [{ owner: `"${PEER}"` }] });
      await expect(publisher.share(CG, data, { publisherPeerId: 'attacker', localOnly: true }))
        .rejects.toThrow('SWM validation failed');
      const retained = await reopened.query(`SELECT ?value WHERE { GRAPH <${DATA}> { <${root}> <urn:data:value> ?value } }`);
      expect(retained).toEqual({ type: 'bindings', bindings: [{ value: '"retained"' }] });
    },
  );
});
