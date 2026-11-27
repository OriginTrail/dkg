import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  contextGraphWorkspaceGraphUri,
  generateEd25519Keypair,
  TypedEventBus,
} from '@origintrail-official/dkg-core';
import {
  DKGPublisher,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import { createTripleStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { seedLegacyRawLiftTestJob } from '../../publisher/test/_helpers/legacy-raw-lift.js';
import { addPublisherWallet } from '../src/publisher-wallets.js';
import {
  createPublisherRuntimeFromAgent,
  type PublisherRuntime,
} from '../src/publisher-runner.js';

const CONTEXT_GRAPH = 'publisher-runtime-snapshot-store-injection';
const ENTITY = 'urn:publisher-runtime:snapshot-store-injection:entity';

describe('publisher runtime public snapshot store injection', () => {
  let dataDir: string | undefined;
  let store: TripleStore | undefined;
  let runtime: PublisherRuntime | undefined;

  afterEach(async () => {
    await runtime?.stop().catch(() => {});
    await store?.close().catch(() => {});
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('prepares queued public quads from the injected snapshot store', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-runtime-snapshot-store-'));
    store = await createTripleStore({ backend: 'oxigraph' });
    const wallet = ethers.Wallet.createRandom();
    const keypair = await generateEd25519Keypair();
    const snapshots = new Map<string, Quad[]>();
    const publicSnapshotStore: WorkspacePublicSnapshotStore = {
      async putSnapshot({ digest, quads }) {
        snapshots.set(digest, quads.map((quad) => ({ ...quad })));
        return { ref: digest, byteLength: 0 };
      },
      async getSnapshot(ref) {
        return snapshots.get(ref)?.map((quad) => ({ ...quad })) ?? null;
      },
    };
    const publicQuads: Quad[] = [{
      subject: ENTITY,
      predicate: 'http://schema.org/name',
      object: '"Injected runtime snapshot store"',
      graph: '',
    }];

    await addPublisherWallet(dataDir, wallet.privateKey);
    const workspaceWriter = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publicSnapshotStore,
    });
    const write = await workspaceWriter.writeToWorkspace(CONTEXT_GRAPH, publicQuads, {
      publisherPeerId: 'publisher-runtime-snapshot-store-peer',
    });
    await store.dropGraph(contextGraphWorkspaceGraphUri(CONTEXT_GRAPH));

    runtime = await createPublisherRuntimeFromAgent({
      dataDir,
      store,
      keypair,
      publicSnapshotStore,
    });
    const jobId = await seedLegacyRawLiftTestJob(store, {
      swmId: 'swm-main',
      shareOperationId: write.shareOperationId,
      roots: [ENTITY],
      contextGraphId: CONTEXT_GRAPH,
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:owner:runtime-snapshot-store' },
    });

    const payload = await runtime.publisher.inspectPreparedPayload(jobId);

    expect(payload?.publishOptions.quads).toEqual(publicQuads);
  });
});
