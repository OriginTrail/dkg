/**
 * V10 UPDATE StorageACK digest-parity (consensus-critical).
 *
 * Asserts that the off-chain `computeUpdateACKDigest` (the digest peers
 * sign + the ACK collector recovers against) produces EXACTLY the same
 * 32 bytes as the chain adapter's `computeV10UpdateAckDigest` for the
 * same inputs. If these ever drift, off-chain-collected signatures would
 * fail the on-chain `KnowledgeAssetsLifecycle._executeUpdateCore` verify
 * and updates would revert `MinSignaturesRequirementNotMet`.
 *
 * Also asserts `getUpdateAckDigestFields` resolves the on-chain fields
 * (contextGraphId / preUpdateMerkleRootCount / floored newTokenAmount)
 * the publisher threads into BOTH the signed digest and the update tx.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { computeUpdateACKDigest } from '@origintrail-official/dkg-core';

// Round-2 review split withRunner → rebindContract (contract.connect(p), no
// test-double fallback). These tests mock this.contracts.* as plain method
// objects; `connectable` makes a mock satisfy that boundary with a
// single-provider NO-OP self-rebind, so the REAL rebindContract runs.
function connectable<T>(mock: T): T {
  const m = mock as { connect?: unknown };
  if (m && typeof m.connect !== 'function') m.connect = () => mock;
  return mock;
}

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const KAV10_ADDRESS = '0x000000000000000000000000000000000000c10a';
const TEST_CHAIN_ID = 31337n;

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    ...overrides,
  };
}

/**
 * Build an adapter whose on-chain reads are stubbed to fixed values so
 * the digest computation is deterministic without a live chain.
 */
function makeStubbedAdapter(opts: {
  contextGraphId: bigint;
  preUpdateMerkleRootCount: bigint;
  currentTokenAmount: bigint;
  /** byteSize the adapter sees as "current" for growth-cost sizing. */
  currentByteSize: bigint;
}) {
  const a = new EVMChainAdapter(minimalConfig());
  (a as any).initialized = true;
  // R1: getEvmChainId reads chainId via readWithFailover over this.providers[0]
  // (=== this.provider in prod). Set the mock on BOTH so the digest's chainId
  // read resolves to the stub instead of dialling the placeholder RPC.
  const provider = { getNetwork: async () => ({ chainId: TEST_CHAIN_ID }) };
  (a as any).provider = provider;
  (a as any).providers = [provider];
  // The contract view reads go through contractReadWithFailover → rebindContract
  // (contract.connect(p)), so the contract stubs must be .connect-able.
  (a as any).contracts.knowledgeAssetsLifecycle = connectable({
    getAddress: async () => KAV10_ADDRESS,
  });
  (a as any).contracts.contextGraphStorage = connectable({
    kaToContextGraph: async () => opts.contextGraphId,
  });
  (a as any).contracts.knowledgeAssetStorage = connectable({
    getMerkleRoots: async () => new Array(Number(opts.preUpdateMerkleRootCount)).fill('0x00'),
    getTokenAmount: async () => opts.currentTokenAmount,
    // (preUpdateMerkleRootCount, minted, byteSize, endEpoch, tokenAmount, isImmutable, preUpdateMerkleLeafCount)
    getKnowledgeAssetUpdateContext: async () => [
      opts.preUpdateMerkleRootCount,
      0n,
      opts.currentByteSize,
      0n,
      opts.currentTokenAmount,
      false,
      0n,
    ],
  });
  return a;
}

describe('V10 UPDATE ACK digest parity (off-chain == adapter)', () => {
  const kaId = 123456789n;
  const contextGraphId = 7n;
  const preUpdateMerkleRootCount = 2n;
  const newMerkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('new-root')));
  const newByteSize = 4096n;
  const currentTokenAmount = 1000n;
  const newMerkleLeafCount = 3;
  const mintAmount = 0n;
  const burnTokenIds: bigint[] = [];

  it('metadata-only update (no byte-size growth): digests match byte-for-byte', async () => {
    // newByteSize <= currentByteSize → growth validator skipped →
    // newTokenAmount == currentTokenAmount (carry-forward).
    const a = makeStubbedAdapter({
      contextGraphId,
      preUpdateMerkleRootCount,
      currentTokenAmount,
      currentByteSize: newByteSize, // equal → no growth
    });

    const adapterDigest = await a.computeV10UpdateAckDigest({
      kaId,
      newMerkleRoot,
      newByteSize,
      newMerkleLeafCount,
      mintAmount,
      burnTokenIds,
    });

    // The adapter floors currentTokenAmount internally; reproduce the
    // resolved newTokenAmount via getUpdateAckDigestFields so the
    // off-chain side uses the IDENTICAL value the publisher would pass.
    const fields = await a.getUpdateAckDigestFields({
      kaId,
      newByteSize,
      mintAmount,
      burnTokenIds,
    });
    expect(fields.contextGraphId).toBe(contextGraphId);
    expect(fields.preUpdateMerkleRootCount).toBe(preUpdateMerkleRootCount);

    const offChainDigest = computeUpdateACKDigest(
      TEST_CHAIN_ID,
      KAV10_ADDRESS,
      fields.contextGraphId,
      kaId,
      fields.preUpdateMerkleRootCount,
      newMerkleRoot,
      newByteSize,
      fields.newTokenAmount,
      fields.mintAmount,
      fields.burnTokenIds,
      BigInt(newMerkleLeafCount),
    );

    expect(Buffer.from(offChainDigest).equals(Buffer.from(adapterDigest))).toBe(true);
    expect(offChainDigest.length).toBe(32);
  });

  it('with explicit user newTokenAmount: bound value flows into both digest paths', async () => {
    const a = makeStubbedAdapter({
      contextGraphId,
      preUpdateMerkleRootCount,
      currentTokenAmount,
      currentByteSize: newByteSize,
    });
    const userTokenAmount = 5000n;

    const fields = await a.getUpdateAckDigestFields({
      kaId,
      newByteSize,
      userProvidedNewTokenAmount: userTokenAmount,
      mintAmount,
      burnTokenIds,
    });
    // No growth + user override above carry-forward → resolved == user value.
    expect(fields.newTokenAmount).toBe(userTokenAmount);

    // Adapter digest using boundNewTokenAmount must equal the off-chain
    // digest built from the same resolved fields.
    const adapterDigest = await a.computeV10UpdateAckDigest({
      kaId,
      newMerkleRoot,
      newByteSize,
      newMerkleLeafCount,
      mintAmount,
      burnTokenIds,
      boundNewTokenAmount: fields.newTokenAmount,
    });
    const offChainDigest = computeUpdateACKDigest(
      TEST_CHAIN_ID,
      KAV10_ADDRESS,
      fields.contextGraphId,
      kaId,
      fields.preUpdateMerkleRootCount,
      newMerkleRoot,
      newByteSize,
      fields.newTokenAmount,
      fields.mintAmount,
      fields.burnTokenIds,
      BigInt(newMerkleLeafCount),
    );
    expect(Buffer.from(offChainDigest).equals(Buffer.from(adapterDigest))).toBe(true);
  });

  it('recovers the operational signer from a peer-signed update digest', async () => {
    const a = makeStubbedAdapter({
      contextGraphId,
      preUpdateMerkleRootCount,
      currentTokenAmount,
      currentByteSize: newByteSize,
    });
    const fields = await a.getUpdateAckDigestFields({ kaId, newByteSize, mintAmount, burnTokenIds });
    const digest = computeUpdateACKDigest(
      TEST_CHAIN_ID,
      KAV10_ADDRESS,
      fields.contextGraphId,
      kaId,
      fields.preUpdateMerkleRootCount,
      newMerkleRoot,
      newByteSize,
      fields.newTokenAmount,
      fields.mintAmount,
      fields.burnTokenIds,
      BigInt(newMerkleLeafCount),
    );

    const peer = ethers.Wallet.createRandom();
    // EIP-191 personal_sign over the 32-byte digest — exactly what the
    // peer handler does (`signerWallet.signMessage(digest)`).
    const sig = ethers.Signature.from(await peer.signMessage(digest));
    const recovered = ethers.recoverAddress(ethers.hashMessage(digest), {
      r: sig.r,
      yParityAndS: sig.yParityAndS,
    });
    expect(recovered.toLowerCase()).toBe(peer.address.toLowerCase());
  });
});
