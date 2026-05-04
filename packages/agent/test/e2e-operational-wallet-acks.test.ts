import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  computePublishACKDigest,
  contextGraphSharedMemoryUri,
  decodeStorageACK,
  encodePublishIntent,
  PROTOCOL_STORAGE_ACK,
  type StorageACKMsg,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCMerkleLeafCountV10,
  computeFlatKCRootV10,
} from '../../publisher/src/merkle.js';
import {
  createEVMAdapter,
  createProvider,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

const ACK_CONTEXT_GRAPH_ID = '42';
const ACK_ENTITY = 'urn:e2e:operational-wallet-ack:entity';
const ACK_TOKEN_AMOUNT = 1000n;
const ACK_EPOCHS = 1;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uint64ToBigInt(value: StorageACKMsg['nodeIdentityId']): bigint {
  if (typeof value === 'number') return BigInt(value);
  return (BigInt(value.high >>> 0) << 32n) + BigInt(value.low >>> 0);
}

function recoverACKSigner(ack: StorageACKMsg, digest: Uint8Array): string {
  const prefixedHash = ethers.hashMessage(digest);
  return ethers.recoverAddress(prefixedHash, {
    r: ethers.hexlify(ack.coreNodeSignatureR),
    yParityAndS: ethers.hexlify(ack.coreNodeSignatureVS),
  });
}

function publicByteSize(quads: Quad[]): number {
  return new TextEncoder().encode(
    quads.map((q) => `${q.subject} ${q.predicate} ${q.object}`).join('\n'),
  ).length;
}

async function removeOperationalKey(identityId: bigint, walletAddress: string): Promise<void> {
  const provider = createProvider();
  const { hubAddress } = getSharedContext();
  const hub = new ethers.Contract(
    hubAddress,
    ['function getContractAddress(string) view returns (address)'],
    provider,
  );
  const identityAddress = await hub.getContractAddress('Identity');
  const admin = new ethers.Wallet(HARDHAT_KEYS.CORE_ADMIN, provider);
  const identity = new ethers.Contract(
    identityAddress,
    ['function removeKey(uint72 identityId, bytes32 key) external'],
    admin,
  );
  const keyHash = ethers.keccak256(ethers.solidityPacked(['address'], [walletAddress]));
  await (await identity.removeKey(identityId, keyHash)).wait();
}

let fileSnapshot: string;

beforeAll(async () => {
  fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(
    provider,
    hubAddress,
    HARDHAT_KEYS.DEPLOYER,
    coreOp.address,
    ethers.parseEther('50000000'),
  );
});

afterAll(async () => {
  await revertSnapshot(fileSnapshot);
});

describe('E2E: operational wallet ACK signing', () => {
  let core: DKGAgent | undefined;
  let requester: DKGAgent | undefined;

  afterAll(async () => {
    await requester?.stop().catch(() => {});
    await core?.stop().catch(() => {});
  });

  it('auto-registers the ACK signer and signs only while the key is confirmed on-chain', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { coreProfileId } = getSharedContext();
    const identityId = BigInt(coreProfileId);
    const ackWallet = new ethers.Wallet(HARDHAT_KEYS.EXTRA1);

    expect(await chain.isOperationalWalletRegistered(identityId, ackWallet.address)).toBe(false);

    core = await DKGAgent.create({
      name: 'OperationalAckCore',
      listenHost: '127.0.0.1',
      listenPort: 0,
      skills: [],
      chainAdapter: chain,
      nodeRole: 'core',
      ackSignerKey: HARDHAT_KEYS.EXTRA1,
    });
    requester = await DKGAgent.create({
      name: 'OperationalAckRequester',
      listenHost: '127.0.0.1',
      listenPort: 0,
      skills: [],
      chainAdapter: new NoChainAdapter(),
      nodeRole: 'edge',
    });

    await core.start();

    expect(await chain.isOperationalWalletRegistered(identityId, ackWallet.address)).toBe(true);
    expect(core.node.libp2p.getProtocols()).toContain(PROTOCOL_STORAGE_ACK);

    await requester.start();
    const coreAddress = core.multiaddrs.find((addr) =>
      addr.includes('/tcp/') && !addr.includes('/p2p-circuit'),
    );
    expect(coreAddress).toBeDefined();
    await requester.connectTo(coreAddress!);
    await sleep(800);

    const quads: Quad[] = [
      {
        subject: ACK_ENTITY,
        predicate: 'http://schema.org/name',
        object: '"Operational ACK"',
        graph: '',
      },
      {
        subject: ACK_ENTITY,
        predicate: 'http://schema.org/version',
        object: '"1"',
        graph: '',
      },
    ];
    await core.store.insert(
      quads.map((quad) => ({
        ...quad,
        graph: contextGraphSharedMemoryUri(ACK_CONTEXT_GRAPH_ID),
      })),
    );

    const merkleRoot = computeFlatKCRootV10(quads, []);
    const merkleLeafCount = computeFlatKCMerkleLeafCountV10(quads, []);
    const byteSize = publicByteSize(quads);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: ACK_CONTEXT_GRAPH_ID,
      publisherPeerId: requester.peerId,
      publicByteSize: byteSize,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [ACK_ENTITY],
      epochs: ACK_EPOCHS,
      tokenAmountStr: ACK_TOKEN_AMOUNT.toString(),
      merkleLeafCount,
    });

    const response = await requester.router.send(core.peerId, PROTOCOL_STORAGE_ACK, intent, 20_000);
    const ack = decodeStorageACK(response);

    expect(uint64ToBigInt(ack.nodeIdentityId)).toBe(identityId);
    expect(ethers.hexlify(ack.merkleRoot)).toBe(ethers.hexlify(merkleRoot));

    const digest = computePublishACKDigest(
      await chain.getEvmChainId(),
      await chain.getKnowledgeAssetsV10Address(),
      BigInt(ACK_CONTEXT_GRAPH_ID),
      merkleRoot,
      1n,
      BigInt(byteSize),
      BigInt(ACK_EPOCHS),
      ACK_TOKEN_AMOUNT,
      BigInt(merkleLeafCount),
    );
    const recovered = recoverACKSigner(ack, digest);

    expect(recovered.toLowerCase()).toBe(ackWallet.address.toLowerCase());
    expect(await chain.verifyACKIdentity(recovered, identityId)).toBe(true);

    await removeOperationalKey(identityId, ackWallet.address);
    expect(await chain.isOperationalWalletRegistered(identityId, ackWallet.address)).toBe(false);
    await expect(
      requester.router.send(core.peerId, PROTOCOL_STORAGE_ACK, intent, 20_000),
    ).rejects.toThrow();
    expect(core.node.libp2p.getProtocols()).not.toContain(PROTOCOL_STORAGE_ACK);
  }, 60_000);
});
