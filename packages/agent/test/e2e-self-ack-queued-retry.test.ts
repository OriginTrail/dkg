import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import {
  bindAndSubscribePublicContextGraph,
  createPublishProtocolAgent,
  sleep,
  type PublishProtocolAgent,
} from './_helpers/publish-protocol.js';
import {
  createEVMAdapter,
  createProvider,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { setMinimumRequiredSignatures } from '../../chain/test/hardhat-harness.js';
import { GraphManager } from '@origintrail-official/dkg-storage';
import {
  resolveKnowledgeAssetWorkspaceHead,
  resolveKnowledgeAssetWorkspaceHeadPublicQuads,
  STORAGE_ACK_LEDGER_GRAPH,
  STORAGE_ACK_LEDGER_PREDICATES,
  TripleStoreAsyncLiftPublisher,
  type KnowledgeAssetVmPublishRequest,
} from '@origintrail-official/dkg-publisher';
import { contextGraphMetaUri, STORAGE_ACK_DECLINE_CODES } from '@origintrail-official/dkg-core';

// #2796: a publishing core counts its own StorageACK. When one of the other
// cores cannot ACK (restarting), the first round includes the self-ACK and
// still misses the 3-signature quorum. The queued job must survive that round:
// its retry re-validates the publisher's SWM head (operation id and access
// envelope), which the self-ACK must not have rewritten.
describe('E2E: queued VM publish retries after a round with a local self-ACK misses quorum', () => {
  const contextGraphId = 'self-ack-queued-retry-e2e';
  let publisherCore: PublishProtocolAgent;
  let coreB: PublishProtocolAgent;
  let coreC: PublishProtocolAgent;
  let describeSnapshot: string | undefined;

  beforeAll(async () => {
    describeSnapshot = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    await setMinimumRequiredSignatures(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, 3);
    const core = (name: string, privateKey: string) => createPublishProtocolAgent({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name,
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(privateKey),
      nodeRole: 'core',
      syncOnConnectEnabled: false,
    });
    publisherCore = await core('SelfAckQueuedPublisher', HARDHAT_KEYS.CORE_OP);
    coreB = await core('SelfAckQueuedCoreB', HARDHAT_KEYS.REC1_OP);
    coreC = await core('SelfAckQueuedCoreC', HARDHAT_KEYS.REC2_OP);
    await publisherCore.start();
    await coreB.start();
    await coreC.start();
    await sleep(800);
    const address = publisherCore.multiaddrs.find(
      (candidate) => candidate.includes('/tcp/') && !candidate.includes('/p2p-circuit'),
    )!;
    await coreB.connectTo(address);
    await coreC.connectTo(address);
    await sleep(2_000);
    expect(publisherCore.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(2);
    await publisherCore.createContextGraph({ id: contextGraphId, name: 'Self-ACK queued retry', description: '' });
    const registration = await publisherCore.registerContextGraph(contextGraphId);
    for (const node of [publisherCore, coreB, coreC]) {
      await bindAndSubscribePublicContextGraph(node, contextGraphId, registration.onChainId);
    }
    await sleep(1_500);
  }, 60_000);

  afterAll(async () => {
    try {
      for (const node of [publisherCore, coreB, coreC]) {
        try { await node?.stop(); } catch {}
      }
    } finally {
      if (describeSnapshot !== undefined) await revertSnapshot(describeSnapshot);
    }
  });

  function queuedPublishes(): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(publisherCore.store, {
      knowledgeAssetVmPublishHandler: {
        preflight: ({ request }) => publisherCore.preflightQueuedKnowledgeAssetVmPublishExecution(request),
        execute: ({ request, publishOptions }) =>
          publisherCore.publishQueuedKnowledgeAssetVmPublish(request, publishOptions),
      },
    });
  }

  /**
   * Core C refuses every ACK until released, like a core that is restarting.
   * Its refusal arrives after the other two ACKs, so the failed round always
   * holds the publisher's own ACK.
   */
  function holdCoreC() {
    return vi.spyOn(coreC as unknown as {
      ensureStorageAckVmPromotion: (...args: unknown[]) => Promise<unknown>;
    }, 'ensureStorageAckVmPromotion').mockImplementation(async () => {
      await sleep(1_500);
      return {
        ok: false,
        code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED,
        message: 'core is restarting',
      };
    });
  }

  function readPublisherHead(request: KnowledgeAssetVmPublishRequest) {
    return resolveKnowledgeAssetWorkspaceHead({
      store: publisherCore.store,
      graphManager: new GraphManager(publisherCore.store),
      contextGraphId,
      kaUal: request.kaUal!,
    });
  }

  /** Retain the queued operation while its valid publisher metadata names another peer. */
  async function overrideQueuedPublisherMetadata(request: KnowledgeAssetVmPublishRequest): Promise<void> {
    const head = await readPublisherHead(request);
    expect(head).toBeDefined();
    const snapshot = await resolveKnowledgeAssetWorkspaceHeadPublicQuads({
      store: publisherCore.store,
      graphManager: new GraphManager(publisherCore.store),
      contextGraphId,
      head: head!,
    });
    await publisherCore.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId,
      kaUal: request.kaUal!,
      assertionVersion: request.assertionVersion!,
      shareOperationId: request.shareOperationId,
      quads: snapshot.quads,
      privateTripleCount: request.privateTripleCount,
      publisherPeerId: coreB.peerId,
      accessPolicy: request.accessPolicy,
      allowedPeers: request.allowedPeers,
      agentAddress: request.agentAddress,
      timestamp: new Date(),
    });
    expect((await readPublisherHead(request))?.publisherPeerId).toBe(coreB.peerId);
  }

  /** Versions of this KA the publisher signed its own StorageACK for. */
  async function selfAckedVersions(kaUal: string): Promise<string[]> {
    const result = await publisherCore.store.query(`SELECT ?version WHERE {
      GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
        ?op <${STORAGE_ACK_LEDGER_PREDICATES.kaUal}> <${kaUal}> ;
          <${STORAGE_ACK_LEDGER_PREDICATES.assertionVersion}> ?version .
      }
    }`);
    return result.type === 'bindings'
      ? result.bindings.map((row) => /^"(\d+)"/.exec(row['version'] ?? '')?.[1] ?? '').sort()
      : [];
  }

  async function runRoundWithCoreCHeld(
    queue: TripleStoreAsyncLiftPublisher,
    jobId: string,
    request: KnowledgeAssetVmPublishRequest,
  ): Promise<void> {
    const before = await readPublisherHead(request);
    expect(before?.shareOperationIds).toContain(request.shareOperationId);
    const hold = holdCoreC();
    try {
      const failed = await queue.processNext('wallet-1');
      expect(failed?.jobId).toBe(jobId);
      expect(failed?.status, JSON.stringify(failed?.failure)).toBe('failed');
      expect(failed?.failure).toMatchObject({ code: 'quorum_unmet', retryable: true });
    } finally {
      hold.mockRestore();
    }
    // The failed round did include the publisher's own ACK. Its ledger row is
    // the last write before the signature, after any head write...
    await expect.poll(() => selfAckedVersions(request.kaUal!), { timeout: 20_000 })
      .toContain(request.assertionVersion);
    // ...and it left the queued share, and its access envelope, as it was.
    expect(await readPublisherHead(request)).toEqual(before);
  }

  async function retryToFinalized(queue: TripleStoreAsyncLiftPublisher, jobId: string) {
    expect(await queue.retryDetailed({ jobId })).toEqual({ retried: 1, blockedPendingRecovery: 0, skipped: 0 });
    const finalized = await queue.processNext('wallet-1');
    expect(finalized?.jobId).toBe(jobId);
    expect(finalized?.status, JSON.stringify(finalized?.failure)).toBe('finalized');
    expect(finalized?.broadcast?.txHash).toEqual(expect.any(String));
    return finalized!;
  }

  it('publishes a queued KA on retry after the first round misses quorum', async () => {
    const name = 'self-ack-queued-publish';
    await publisherCore.assertion.create(contextGraphId, name);
    await publisherCore.assertion.write(contextGraphId, name, [{
      subject: 'urn:self-ack:queued-publish',
      predicate: 'http://schema.org/name',
      object: '"published after a quorum miss"',
    }]);
    await publisherCore.assertion.promote(contextGraphId, name, {
      accessPolicy: 'allowList',
      allowedPeers: [coreB.peerId, coreC.peerId],
    });
    const intent = await publisherCore.resolveFinalizedAssertionVmPublishIntent(contextGraphId, name);
    expect(intent.vmCurrentAssertion).toBeUndefined();
    await overrideQueuedPublisherMetadata(intent);
    const queue = queuedPublishes();
    const jobId = await queue.enqueueKnowledgeAssetVmPublish(intent);

    await runRoundWithCoreCHeld(queue, jobId, intent);
    await retryToFinalized(queue, jobId);

    expect(await publisherCore.assertion.history(contextGraphId, name)).toMatchObject({
      vmCurrentAssertion: intent.sealMerkleRoot.slice(2),
    });
  }, 180_000);

  it('updates a queued KA on retry and keeps its allow-list through the failed round', async () => {
    const name = 'self-ack-queued-update';
    const subject = 'urn:self-ack:queued-update';
    await publisherCore.assertion.create(contextGraphId, name);
    await publisherCore.assertion.write(contextGraphId, name, [
      { subject, predicate: 'http://schema.org/name', object: '"v1"' },
    ]);
    await publisherCore.assertion.promote(contextGraphId, name);
    const published = await publisherCore.publishFromFinalizedAssertion(contextGraphId, name);
    expect(published.status).toBe('confirmed');
    // An update ACK replaces a core's v1 copy only once v1 is in its VM.
    for (const node of [coreB, coreC]) {
      await expect.poll(async () => {
        const promoted = await node.store.query(`ASK { GRAPH <${contextGraphMetaUri(contextGraphId)}> {
          <${published.ual}> <http://dkg.io/ontology/status> "confirmed" } }`);
        return promoted.type === 'boolean' && promoted.value;
      }, { timeout: 30_000, interval: 500 }).toBe(true);
    }

    await publisherCore.assertion.pullFrom(contextGraphId, name, 'vm', { onConflict: 'replace' });
    await publisherCore.assertion.write(contextGraphId, name, [
      { subject, predicate: 'http://schema.org/name', object: '"v2"' },
    ]);
    await publisherCore.assertion.finalize(contextGraphId, name);
    const allowedPeers = [coreB.peerId, coreC.peerId].sort();
    await publisherCore.assertion.promote(contextGraphId, name, { accessPolicy: 'allowList', allowedPeers });
    const intent = await publisherCore.resolveFinalizedAssertionVmPublishIntent(contextGraphId, name);
    expect(intent).toMatchObject({ assertionVersion: '2', accessPolicy: 'allowList', allowedPeers });
    expect(intent.vmCurrentAssertion).toBeDefined();
    await overrideQueuedPublisherMetadata(intent);
    const queue = queuedPublishes();
    const jobId = await queue.enqueueKnowledgeAssetVmPublish(intent);

    await runRoundWithCoreCHeld(queue, jobId, intent);
    expect(await readPublisherHead(intent)).toMatchObject({
      assertionVersion: '2',
      access: { kind: 'persisted', accessPolicy: 'allowList', allowedPeers },
    });
    const finalized = await retryToFinalized(queue, jobId);
    expect(finalized.broadcast).toMatchObject({ operationKind: 'update' });

    expect(await publisherCore.assertion.history(contextGraphId, name)).toMatchObject({
      vmCurrentAssertion: intent.sealMerkleRoot.slice(2),
    });
  }, 240_000);
});
