import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import { computeFlatKCRootV10 as computeFlatKCRoot, computeFlatKCRootV10, computeTripleHashV10 } from '../src/merkle.js';
import {
  encodePublishIntent, decodePublishIntent,
  encodeStorageACK, decodeStorageACK,
  computePublishACKDigest,
  computePublishPublisherDigest,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens, setMinimumRequiredSignatures, stakeAndSetAsk } from '../../chain/test/hardhat-harness.js';

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('V10 Publish E2E', () => {
  const contextGraphId = '42';
  const cgIdBigInt = 42n;
  const swmGraphUri = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;

  const publishQuads: Quad[] = [
    makeQuad('urn:experiment:wsd', 'http://schema.org/name', '"Word Sense Disambiguation"'),
    makeQuad('urn:experiment:wsd', 'urn:exp:val_bpb', '"1.36"'),
    makeQuad('urn:experiment:wsd', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'urn:exp:Experiment'),
  ];

  const coreWallets = [
    ethers.Wallet.createRandom(),
    ethers.Wallet.createRandom(),
    ethers.Wallet.createRandom(),
  ];

  const publisherWallet = ethers.Wallet.createRandom();

  let chainCgId: bigint;
  let realKAV10Addr: string;
  let _fileSnapshot: string;

  beforeAll(async () => {
    _fileSnapshot = await takeSnapshot();
    const ctx = getSharedContext();
    const provider = createProvider();
    const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));

    for (let i = 0; i < ctx.receiverIds.length; i++) {
      const recOpKey = [HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC2_OP, HARDHAT_KEYS.REC3_OP][i]!;
      await stakeAndSetAsk(provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, recOpKey, ctx.receiverIds[i]!);
    }

    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const cgResult = await adapter.createOnChainContextGraph({
      participantIdentityIds: [
        BigInt(ctx.coreProfileId),
        ...ctx.receiverIds.map(id => BigInt(id)),
      ],
      requiredSignatures: 3,
      publishPolicy: 0,
    });
    if (!cgResult.success || cgResult.contextGraphId === 0n) {
      throw new Error(`Failed to create on-chain context graph: ${JSON.stringify(cgResult)}`);
    }
    chainCgId = cgResult.contextGraphId;
    realKAV10Addr = await adapter.getKnowledgeAssetsV10Address();
  });
  afterAll(async () => {
    await revertSnapshot(_fileSnapshot);
  });

  it('StorageACKHandler + ACKCollector round-trip', async () => {
    const merkleRoot = computeFlatKCRoot(publishQuads, []);
    const rootEntities = ['urn:experiment:wsd'];

    const store = {
      insert: async () => {},
      delete: async () => {},
      deleteByPattern: async () => {},
      hasGraph: async () => true,
      createGraph: async () => {},
      dropGraph: async () => {},
      query: async (sparql: string) => {
        const entityMatch = sparql.match(/FILTER\(\?s = <([^>]+)>/);
        if (entityMatch) {
          const entity = entityMatch[1];
          const genidPrefix = `${entity}/.well-known/genid/`;
          const filtered = publishQuads.filter(q =>
            q.subject === entity || q.subject.startsWith(genidPrefix),
          );
          return { type: 'quads' as const, quads: filtered };
        }
        return { type: 'quads' as const, quads: publishQuads };
      },
      close: async () => {},
    };

    const noopBus = { emit: () => {}, on: () => {}, off: () => {}, once: () => {} };

    const handlers = coreWallets.map((wallet, idx) => {
      const config: StorageACKHandlerConfig = {
        nodeRole: 'core',
        nodeIdentityId: BigInt(idx + 1),
        signerWallet: wallet,
        contextGraphSharedMemoryUri: (cgId: string) =>
          `did:dkg:context-graph:${cgId}/_shared_memory`,
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
      };
      return new StorageACKHandler(store as any, config, noopBus as any);
    });

    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (peerId, _protocol, data) => {
        const idx = parseInt(peerId.replace('core-', ''), 10);
        const handler = handlers[idx];
        const fakePeerId = { toString: () => peerId };
        return handler.handler(data, fakePeerId);
      },
      getConnectedCorePeers: () => ['core-0', 'core-1', 'core-2'],
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    const result = await collector.collect({
      merkleRoot,
      contextGraphId: cgIdBigInt,
      contextGraphIdStr: contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: BigInt(publishQuads.length * 100),
      isPrivate: false,
      kaCount: 1,
      rootEntities,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    });

    expect(result.acks).toHaveLength(3);

    const digest = computePublishACKDigest(
      TEST_CHAIN_ID,
      TEST_KAV10_ADDR,
      cgIdBigInt,
      merkleRoot,
      1n,
      BigInt(publishQuads.length * 100),
      1n,
      0n,
    );
    const prefixedHash = ethers.hashMessage(digest);

    for (let i = 0; i < 3; i++) {
      const ack = result.acks[i];
      const recovered = ethers.recoverAddress(prefixedHash, {
        r: ethers.hexlify(ack.signatureR),
        yParityAndS: ethers.hexlify(ack.signatureVS),
      });
      const coreAddresses = coreWallets.map(w => w.address.toLowerCase());
      expect(coreAddresses).toContain(recovered.toLowerCase());
    }
  });

  it('V10 merkle root is deterministic across all nodes', () => {
    const root1 = computeFlatKCRootV10(publishQuads, []);
    const root2 = computeFlatKCRootV10(publishQuads, []);

    expect(Buffer.from(root1).equals(Buffer.from(root2))).toBe(true);

    const reversed = [...publishQuads].reverse();
    const root3 = computeFlatKCRootV10(reversed, []);
    expect(Buffer.from(root1).equals(Buffer.from(root3))).toBe(true);
  });

  it('V10 merkle root differs from V9 SHA-256 root', async () => {
    const { computeFlatKCRoot } = await import('../src/merkle.js');

    const v9Root = computeFlatKCRoot(publishQuads, []);
    const v10Root = computeFlatKCRootV10(publishQuads, []);

    expect(Buffer.from(v9Root).equals(Buffer.from(v10Root))).toBe(false);
    expect(v9Root.length).toBe(32);
    expect(v10Root.length).toBe(32);
  });

  it('PublishIntent encodes and decodes correctly', () => {
    const merkleRoot = computeFlatKCRootV10(publishQuads, []);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'Qm_publisher_123',
      publicByteSize: 1024,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:experiment:wsd'],
    });

    const decoded = decodePublishIntent(intent);
    expect(decoded.contextGraphId).toBe(contextGraphId);
    expect(decoded.publisherPeerId).toBe('Qm_publisher_123');
    expect(decoded.isPrivate).toBe(false);
    expect(decoded.kaCount).toBe(1);
    expect(decoded.rootEntities).toEqual(['urn:experiment:wsd']);

    const decodedRoot = decoded.merkleRoot instanceof Uint8Array
      ? decoded.merkleRoot
      : new Uint8Array(decoded.merkleRoot);
    expect(Buffer.from(decodedRoot).equals(Buffer.from(merkleRoot))).toBe(true);
  });

  it('StorageACK encodes and decodes correctly', async () => {
    const merkleRoot = computeFlatKCRootV10(publishQuads, []);
    const wallet = coreWallets[0];
    const digest = computePublishACKDigest(
      TEST_CHAIN_ID, TEST_KAV10_ADDR, cgIdBigInt, merkleRoot,
      1n, BigInt(publishQuads.length * 100), 1n, 0n,
    );
    const sig = ethers.Signature.from(await wallet.signMessage(digest));

    const encoded = encodeStorageACK({
      merkleRoot,
      coreNodeSignatureR: ethers.getBytes(sig.r),
      coreNodeSignatureVS: ethers.getBytes(sig.yParityAndS),
      contextGraphId,
      nodeIdentityId: 1,
    });

    const decoded = decodeStorageACK(encoded);
    expect(decoded.contextGraphId).toBe(contextGraphId);

    const decodedRoot = decoded.merkleRoot instanceof Uint8Array
      ? decoded.merkleRoot
      : new Uint8Array(decoded.merkleRoot);
    expect(Buffer.from(decodedRoot).equals(Buffer.from(merkleRoot))).toBe(true);

    const decodedR = decoded.coreNodeSignatureR instanceof Uint8Array
      ? decoded.coreNodeSignatureR
      : new Uint8Array(decoded.coreNodeSignatureR);
    expect(decodedR.length).toBe(32);
  });

  it('V10 EVM adapter round-trip: ACK collection → createKnowledgeAssetsV10', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { hubAddress, receiverIds, coreProfileId } = getSharedContext();
    const provider = createProvider();
    await setMinimumRequiredSignatures(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, 3);

    const merkleRoot = computeFlatKCRootV10(publishQuads, []);
    const publisherIdentityId = BigInt(coreProfileId);
    const byteSize = BigInt(publishQuads.length * 100);
    const epochs = 2n;
    const tokenAmount = await adapter.getRequiredPublishTokenAmount(byteSize, epochs);

    const receiverKeys = [HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC2_OP, HARDHAT_KEYS.REC3_OP];
    const ackSignatures = await Promise.all(
      receiverKeys.map(async (key, idx) => {
        const wallet = new ethers.Wallet(key);
        const digest = computePublishACKDigest(
          TEST_CHAIN_ID, realKAV10Addr, chainCgId, merkleRoot,
          BigInt(publishQuads.length), byteSize, epochs, tokenAmount,
        );
        const sig = ethers.Signature.from(await wallet.signMessage(digest));
        return {
          identityId: BigInt(receiverIds[idx]!),
          r: ethers.getBytes(sig.r),
          vs: ethers.getBytes(sig.yParityAndS),
        };
      }),
    );

    expect(ackSignatures).toHaveLength(3);

    const pubWallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const pubSig = ethers.Signature.from(
      await pubWallet.signMessage(
        computePublishPublisherDigest(
          TEST_CHAIN_ID,
          realKAV10Addr,
          publisherIdentityId,
          chainCgId,
          merkleRoot,
        ),
      ),
    );

    const result = await adapter.createKnowledgeAssetsV10!({
      publishOperationId: 'v10-e2e-test',
      contextGraphId: chainCgId,
      merkleRoot,
      knowledgeAssetsAmount: publishQuads.length,
      byteSize,
      epochs: Number(epochs),
      tokenAmount,
      isImmutable: false,
      paymaster: ethers.ZeroAddress,
      publisherNodeIdentityId: publisherIdentityId,
      publisherSignature: {
        r: ethers.getBytes(pubSig.r),
        vs: ethers.getBytes(pubSig.yParityAndS),
      },
      ackSignatures,
    });

    expect(result.batchId).toBeGreaterThan(0n);
    expect(result.txHash).toBeDefined();
    expect(result.tokenAmount).toBe(tokenAmount);
    expect(result.publisherAddress).toBeDefined();
  });
});
