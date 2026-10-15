import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlazegraphNamespaceManager,
  BlazegraphStore,
  blazegraphNamespaceApiUrlFromSparqlEndpoint,
} from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import {
  KA_VM_EXECUTOR_TX_HASH,
  KA_VM_VALIDATION,
  kaVmPublishRequest,
} from '../../../scripts/testing/ka-vm-publish.js';

const endpoint = process.env.BLAZEGRAPH_TEST_URL;

describe.skipIf(!endpoint)('async publisher wallet ownership (live Blazegraph)', () => {
  const id = randomUUID();
  const namespace = `publisher-wallet-ownership-${id}`;
  const graphUri = `urn:test:publisher-wallet-ownership:${id}`;
  const occupiedWallet = `occupied-${id}`;
  const availableWallet = `available-${id}`;
  let manager: BlazegraphNamespaceManager;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> = [];
  let store: BlazegraphStore | undefined;

  beforeAll(async () => {
    manager = new BlazegraphNamespaceManager({
      namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint!),
      requestTimeoutMs: 10_000,
    });
    // Wallet locks and journals use fixed graph names. Own an entire fresh namespace so
    // setup and teardown cannot touch another publisher's state in the supplied endpoint.
    expect(new URL(manager.sparqlUrl(namespace)).pathname).not.toBe(new URL(endpoint!).pathname);
    handles = await manager.acquireMany([namespace]);
    store = new BlazegraphStore(handles[0]!.sparqlUrl, { timeout: 10_000 });
  }, 30_000);

  afterAll(async () => {
    try {
      await store?.close();
    } finally {
      if (handles.length > 0) {
        expect(handles).toHaveLength(1);
        expect(handles[0]!.namespace).toBe(namespace);
        expect(handles[0]!.sparqlUrl).toBe(manager.sparqlUrl(namespace));
        await manager.disposeAll(handles);
      }
    }
  }, 30_000);

  it('keeps proof-bound ownership before and after lease expiry while another wallet progresses', async () => {
    let now = 1_000;
    let sequence = 0;
    const config = {
      graphUri,
      now: () => now,
      idGenerator: () => `${id}-job-${++sequence}`,
      claimTokenGenerator: () => `${id}-claim-${++sequence}`,
      autoRetryEnabled: false,
    };
    const publisher = new TripleStoreAsyncLiftPublisher(store!, config);
    const contender = new TripleStoreAsyncLiftPublisher(store!, config);
    const firstId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      name: `first-${id}`, shareOperationId: `first-${id}`,
    }));
    const claimed = await publisher.claimNext(occupiedWallet);
    expect(claimed?.jobId).toBe(firstId);
    if (!claimed) throw new Error('Expected first wallet claim');

    await publisher.update(firstId, 'validated', { validation: KA_VM_VALIDATION });
    // Persist canonical broadcast metadata through the public transition API; no transaction
    // is signed or sent. The regression is the real backend's wallet-to-payload OPTIONAL join.
    await publisher.update(firstId, 'broadcast', {
      broadcast: {
        txHash: KA_VM_EXECUTOR_TX_HASH,
        walletId: occupiedWallet,
        nonce: 1,
        operationKind: 'create',
      },
    });
    const proofBound = await publisher.getStatus(firstId);
    expect(proofBound?.status).toBe('broadcast');
    const nextId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      name: `next-${id}`, shareOperationId: `next-${id}`,
    }));
    const accepted = await publisher.getStatus(nextId);
    expect(accepted?.status).toBe('accepted');
    expect(claimed.claim.claimLeaseExpiresAt).toBeGreaterThan(now);

    expect(await contender.claimNext(occupiedWallet)).toBeNull();
    expect(await publisher.getStatus(nextId)).toEqual(accepted);
    expect(await publisher.getStatus(firstId)).toEqual(proofBound);

    now = claimed.claim.claimLeaseExpiresAt + 1;
    expect(await contender.claimNext(occupiedWallet)).toBeNull();
    expect(await publisher.getStatus(nextId)).toEqual(accepted);
    expect(await publisher.getStatus(firstId)).toEqual(proofBound);

    const nextClaim = await contender.claimNext(availableWallet);
    expect(nextClaim?.jobId).toBe(nextId);
    expect(nextClaim?.claim.walletId).toBe(availableWallet);
    expect(await publisher.getStatus(firstId)).toEqual(proofBound);
  }, 60_000);
});
