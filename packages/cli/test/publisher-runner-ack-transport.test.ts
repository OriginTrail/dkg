/**
 * ACK transport handoff regression for the async publisher runtime.
 *
 * The daemon wires `ackTransportFactory` into the async publisher, but the
 * meaningful boundary is inside `processNext`: the runner must build a V10 ACK
 * provider from that factory and pass the resulting transport deps to
 * `ACKCollector`. This keeps the test hermetic by making NoChainAdapter look
 * V10-ready and stubbing the final `DKGPublisher.publish` chain write.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { generateEd25519Keypair, TypedEventBus } from '@origintrail-official/dkg-core';
import {
  ACKCollector,
  DKGPublisher,
  TripleStoreAsyncLiftPublisher,
  type ACKCollectorDeps,
  type ACKCollectorParams,
  type ACKTransport,
  type PublishOptions,
  type V10ACKProviderParams,
} from '@origintrail-official/dkg-publisher';
import { createTripleStore } from '@origintrail-official/dkg-storage';
import { addPublisherWallet } from '../src/publisher-wallets.js';
import { createPublisherRuntimeFromAgent } from '../src/publisher-runner.js';

type V10ReadyNoChainPrototype = typeof NoChainAdapter.prototype & {
  getMinimumRequiredSignatures?: () => Promise<number>;
  verifyACKIdentity?: (recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>;
  verifyACKIdentityDetailed?: (
    recoveredAddress: string,
    claimedIdentityId: bigint,
  ) => Promise<{ valid: boolean; reason?: 'key-not-registered' | 'not-in-sharding-table' | 'rpc-error' }>;
};

describe('publisher runner ACK transport handoff', () => {
  it('builds the processNext V10 ACK provider from ackTransportFactory transport deps', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-ack-transport-'));
    const wallet = ethers.Wallet.createRandom();
    const store = await createTripleStore({ backend: 'oxigraph' });
    const keypair = await generateEd25519Keypair();
    await addPublisherWallet(dataDir, wallet.privateKey);

    const writer = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
    });
    const write = await writer.writeToWorkspace('1', [
      {
        subject: 'urn:local:/ack-transport',
        predicate: 'http://schema.org/name',
        object: '"ACK Transport"',
        graph: '',
      },
    ], { publisherPeerId: 'writer-peer' });

    const noChainPrototype = NoChainAdapter.prototype as V10ReadyNoChainPrototype;
    const originalGetMinimumRequiredSignatures = noChainPrototype.getMinimumRequiredSignatures;
    const originalVerifyACKIdentity = noChainPrototype.verifyACKIdentity;
    const originalVerifyACKIdentityDetailed = noChainPrototype.verifyACKIdentityDetailed;

    const isV10ReadySpy = vi.spyOn(noChainPrototype, 'isV10Ready').mockReturnValue(true);
    const getEvmChainIdSpy = vi.spyOn(noChainPrototype, 'getEvmChainId').mockResolvedValue(31337n);
    const getKAV10AddressSpy = vi
      .spyOn(noChainPrototype, 'getKnowledgeAssetsLifecycleAddress')
      .mockResolvedValue('0x0000000000000000000000000000000000000001');
    noChainPrototype.getMinimumRequiredSignatures = vi.fn(async () => 2);
    noChainPrototype.verifyACKIdentity = vi.fn(async () => true);
    noChainPrototype.verifyACKIdentityDetailed = vi.fn(async () => ({ valid: true }));

    const gossipPublish = vi.fn(async () => undefined);
    const sendP2P = vi.fn(async () => new Uint8Array([0xac, 0x6b]));
    const getConnectedCorePeers = vi.fn(() => ['core-peer-a', 'core-peer-b']);
    const log = vi.fn();
    const ackTransportFactory = vi.fn((): ACKTransport => ({
      publisherPeerId: 'publisher-peer-from-factory',
      gossipPublish,
      sendP2P,
      getConnectedCorePeers,
      log,
    }));

    let capturedCollectorDeps: ACKCollectorDeps | undefined;
    let capturedCollectorParams: ACKCollectorParams | undefined;
    const collectSpy = vi.spyOn(ACKCollector.prototype, 'collect').mockImplementation(
      async function (this: ACKCollector, params: ACKCollectorParams) {
        capturedCollectorDeps = (this as unknown as { deps: ACKCollectorDeps }).deps;
        capturedCollectorParams = params;
        return {
          acks: [],
          merkleRoot: params.merkleRoot,
          contextGraphId: params.contextGraphId,
        };
      },
    );

    const providerParams: V10ACKProviderParams = {
      merkleRoot: new Uint8Array(32).fill(0x42),
      contextGraphId: '1',
      kaCount: 1,
      rootEntities: ['urn:local:/ack-transport'],
      publicByteSize: 123n,
      merkleLeafCount: 1,
      ackMode: { kind: 'public' },
      stagingQuads: new Uint8Array([0x01, 0x02, 0x03]),
    };
    let capturedPublishOptions: PublishOptions | undefined;
    let providerResult: unknown;
    const publishSpy = vi.spyOn(DKGPublisher.prototype, 'publish').mockImplementation(async (opts: PublishOptions) => {
      capturedPublishOptions = opts;
      const provider = opts.v10ACKProvider as ((params: V10ACKProviderParams) => Promise<unknown>) | undefined;
      if (!provider) {
        throw new Error('Expected runner-generated v10ACKProvider');
      }
      providerResult = await provider(providerParams);
      return {
        kaId: 1n,
        ual: 'did:dkg:hardhat/31337/1',
        merkleRoot: providerParams.merkleRoot,
        kaManifest: [],
        status: 'confirmed',
        onChainResult: {
          batchId: 1n,
          startKAId: 1n,
          endKAId: 1n,
          txHash: `0x${'11'.repeat(32)}`,
          blockNumber: 123,
          blockTimestamp: 456,
          publisherAddress: wallet.address,
        },
      };
    });

    let runtime: Awaited<ReturnType<typeof createPublisherRuntimeFromAgent>> | undefined;
    try {
      runtime = await createPublisherRuntimeFromAgent({
        dataDir,
        store,
        keypair,
        chainBase: undefined,
        pollIntervalMs: 10,
        errorBackoffMs: 10,
        ackTransportFactory,
      });

      const jobId = await new TripleStoreAsyncLiftPublisher(store, {
        legacyRawLiftWriteCapability: 'migration-only',
      }).lift({
        swmId: 'swm-main',
        shareOperationId: write.shareOperationId,
        roots: ['urn:local:/ack-transport'],
        contextGraphId: '1',
        namespace: 'aloha',
        scope: 'transport-regression',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      });

      const processed = await runtime.publisher.processNext(wallet.address);

      expect(processed?.jobId).toBe(jobId);
      expect(processed?.status).toBe('finalized');
      expect(ackTransportFactory).toHaveBeenCalledTimes(1);
      expect(capturedPublishOptions?.v10ACKProvider).toBeTypeOf('function');
      expect(providerResult).toEqual([]);

      expect(capturedCollectorDeps?.gossipPublish).toBe(gossipPublish);
      expect(capturedCollectorDeps?.sendP2P).toBe(sendP2P);
      expect(capturedCollectorDeps?.getConnectedCorePeers).toBe(getConnectedCorePeers);
      expect(capturedCollectorDeps?.log).toBe(log);
      expect(capturedCollectorDeps?.verifyIdentity).toBeTypeOf('function');
      expect(capturedCollectorDeps?.verifyIdentityDetailed).toBeTypeOf('function');

      expect(capturedCollectorParams).toMatchObject({
        publisherPeerId: 'publisher-peer-from-factory',
        contextGraphId: 1n,
        contextGraphIdStr: '1',
        publicByteSize: 123n,
        kaCount: 1,
        rootEntities: ['urn:local:/ack-transport'],
        chainId: 31337n,
        kav10Address: '0x0000000000000000000000000000000000000001',
        requiredACKs: 2,
        merkleLeafCount: 1,
        ackMode: { kind: 'public' },
      });
    } finally {
      publishSpy.mockRestore();
      collectSpy.mockRestore();
      isV10ReadySpy.mockRestore();
      getEvmChainIdSpy.mockRestore();
      getKAV10AddressSpy.mockRestore();
      if (originalGetMinimumRequiredSignatures) {
        noChainPrototype.getMinimumRequiredSignatures = originalGetMinimumRequiredSignatures;
      } else {
        delete noChainPrototype.getMinimumRequiredSignatures;
      }
      if (originalVerifyACKIdentity) {
        noChainPrototype.verifyACKIdentity = originalVerifyACKIdentity;
      } else {
        delete noChainPrototype.verifyACKIdentity;
      }
      if (originalVerifyACKIdentityDetailed) {
        noChainPrototype.verifyACKIdentityDetailed = originalVerifyACKIdentityDetailed;
      } else {
        delete noChainPrototype.verifyACKIdentityDetailed;
      }
      await runtime?.stop();
      await store.close();
    }
  });
});
