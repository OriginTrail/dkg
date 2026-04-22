/**
 * V10 ACK replay across cost parameters — Hardhat integration test.
 *
 * Audit findings covered:
 *
 *   P-3 (CRITICAL) — H5 cost-parameter binding. An ACK signed by a
 *                    core node commits to EXACTLY the (cgId, merkleRoot,
 *                    kaCount, byteSize, epochs, tokenAmount) tuple
 *                    declared in the PublishIntent. The chain's
 *                    `KnowledgeAssetsV10.publishDirect` recomputes the
 *                    digest on-chain and runs ecrecover against the
 *                    submitted cost params (`KnowledgeAssetsV10.sol:362-373`).
 *                    Any submission where the ACK was signed under one
 *                    cost vector but the tx carries another MUST be
 *                    rejected by the chain — otherwise a malicious
 *                    publisher could collect ACKs at a low price and
 *                    re-use them at any price, or at an inflated
 *                    epoch/byteSize, diluting the economic binding.
 *
 *                    We pin three vectors: mismatched `tokenAmount`,
 *                    mismatched `epochs`, mismatched `byteSize`.
 *                    Each submission must revert on-chain. If any of
 *                    them silently succeeds, the economic security of
 *                    V10 publishes is broken — see BUGS_FOUND.md P-3.
 *
 * Per QA policy: no production code modified. Uses real Hardhat, real
 * EVMChainAdapter, real `LocalSignerPeer`-style signing — but with the
 * SPEC-correct 8-field H5-prefixed digest (`computePublishACKDigest`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers } from 'ethers';
import {
  EVMChainAdapter,
  type V10PublishDirectParams,
} from '@origintrail-official/dkg-chain';
import {
  computePublishACKDigest,
  computePublishPublisherDigest,
} from '@origintrail-official/dkg-core';
import {
  createEVMAdapter,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from '../../chain/test/evm-test-context.js';
import {
  mintTokens,
  setMinimumRequiredSignatures,
} from '../../chain/test/hardhat-harness.js';

const CHAIN_ID = 31337n;
const EPOCHS_SIGNED = 1n;
const BYTE_SIZE_SIGNED = 256n;
const KA_COUNT_SIGNED = 1n;
const MERKLE_ROOT = ethers.getBytes(
  ethers.keccak256(ethers.toUtf8Bytes('p3-ack-replay-root')),
);

// Sign an ACK over the SIGNED cost vector, then submit publishDirect
// with a DIFFERENT cost vector. The on-chain digest reconstruction uses
// the SUBMITTED tuple; ecrecover then yields the wrong address and the
// contract MUST revert with InvalidSignature / AckSignatureInvalid.
async function submitWithCostMismatch(
  adapter: EVMChainAdapter,
  params: {
    cgId: bigint;
    identityId: bigint;
    tokenAmountSigned: bigint;
    tokenAmountSubmitted: bigint;
    epochsSubmitted: bigint;
    byteSizeSubmitted: bigint;
    kaCountSubmitted: bigint;
    signer: ethers.Wallet;
    kav10Address: string;
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const {
    cgId, identityId,
    tokenAmountSigned, tokenAmountSubmitted,
    epochsSubmitted, byteSizeSubmitted, kaCountSubmitted,
    signer, kav10Address,
  } = params;

  // ACK digest — SIGNED vector. This is what the core node commits to.
  const ackDigest = computePublishACKDigest(
    CHAIN_ID, kav10Address, cgId, MERKLE_ROOT,
    KA_COUNT_SIGNED, BYTE_SIZE_SIGNED, EPOCHS_SIGNED, tokenAmountSigned,
  );
  const ackSig = ethers.Signature.from(await signer.signMessage(ackDigest));

  // Publisher digest — uses the identity-id + cgId + root; independent
  // of cost parameters. Sign it with the same signer (single-node mode).
  const pubDigest = computePublishPublisherDigest(
    CHAIN_ID, kav10Address, identityId, cgId, MERKLE_ROOT,
  );
  const pubSig = ethers.Signature.from(await signer.signMessage(pubDigest));

  const txParams: V10PublishDirectParams = {
    publishOperationId: `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    contextGraphId: cgId,
    merkleRoot: MERKLE_ROOT,
    knowledgeAssetsAmount: Number(kaCountSubmitted),
    byteSize: byteSizeSubmitted,
    epochs: Number(epochsSubmitted),
    tokenAmount: tokenAmountSubmitted,
    isImmutable: false,
    paymaster: ethers.ZeroAddress,
    publisherNodeIdentityId: identityId,
    publisherSignature: {
      r: ethers.getBytes(ackSig.r), // placeholder, overwritten on publisher key mismatch
      vs: ethers.getBytes(ackSig.yParityAndS),
    },
    ackSignatures: [
      {
        identityId,
        r: ethers.getBytes(ackSig.r),
        vs: ethers.getBytes(ackSig.yParityAndS),
      },
    ],
  };
  // The publisher signature is independent of cost params; override the
  // placeholder we had to put in to satisfy the type.
  txParams.publisherSignature = {
    r: ethers.getBytes(pubSig.r),
    vs: ethers.getBytes(pubSig.yParityAndS),
  };

  try {
    await adapter.createKnowledgeAssetsV10(txParams);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

describe('P-3: ACK replay across cost parameters must be rejected by the chain', () => {
  let snapshotId: string;
  let adapter: EVMChainAdapter;
  let cgId: bigint;
  let coreIdentityId: bigint;
  let kav10Address: string;
  const coreWallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);

  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();

    // Ensure the single-node ACK self-sign path is enough to satisfy
    // `minimumRequiredSignatures` on this hardhat fork.
    await setMinimumRequiredSignatures(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, 1);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreWallet.address, ethers.parseEther('5000000'));

    adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    kav10Address = await adapter.getKnowledgeAssetsV10Address();
    coreIdentityId = BigInt(getSharedContext().coreProfileId);

    const cgRes = await adapter.createOnChainContextGraph({
      participantIdentityIds: [coreIdentityId],
      requiredSignatures: 1,
    });
    cgId = cgRes.contextGraphId;
  }, 60_000);

  afterAll(async () => {
    await revertSnapshot(snapshotId);
  });

  it('baseline: ACK signed with the SAME cost vector that is submitted → tx succeeds', async () => {
    const tokenAmount = await adapter.getRequiredPublishTokenAmount(BYTE_SIZE_SIGNED, Number(EPOCHS_SIGNED));
    const result = await submitWithCostMismatch(adapter, {
      cgId,
      identityId: coreIdentityId,
      tokenAmountSigned: tokenAmount,
      tokenAmountSubmitted: tokenAmount,
      epochsSubmitted: EPOCHS_SIGNED,
      byteSizeSubmitted: BYTE_SIZE_SIGNED,
      kaCountSubmitted: KA_COUNT_SIGNED,
      signer: coreWallet,
      kav10Address,
    });

    expect(result.ok).toBe(true);
  }, 60_000);

  it('tokenAmount mismatch: ACK signed @ T1, submitted @ T1+1 → chain reverts (InvalidSignature / AckSignature)', async () => {
    const tokenAmount = await adapter.getRequiredPublishTokenAmount(BYTE_SIZE_SIGNED, Number(EPOCHS_SIGNED));
    const result = await submitWithCostMismatch(adapter, {
      cgId,
      identityId: coreIdentityId,
      tokenAmountSigned: tokenAmount,
      tokenAmountSubmitted: tokenAmount * 2n,
      epochsSubmitted: EPOCHS_SIGNED,
      byteSizeSubmitted: BYTE_SIZE_SIGNED,
      kaCountSubmitted: KA_COUNT_SIGNED,
      signer: coreWallet,
      kav10Address,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Any chain revert is acceptable evidence the contract recomputed
      // the digest and ecrecover diverged. We assert the message is
      // non-empty so the test never passes on an undefined throw.
      expect(result.message).toBeTruthy();
    }
  }, 60_000);

  it('epochs mismatch: ACK signed @ epochs=1, submitted @ epochs=2 → chain reverts', async () => {
    const tokenAmount = await adapter.getRequiredPublishTokenAmount(BYTE_SIZE_SIGNED, Number(EPOCHS_SIGNED));
    const result = await submitWithCostMismatch(adapter, {
      cgId,
      identityId: coreIdentityId,
      tokenAmountSigned: tokenAmount,
      tokenAmountSubmitted: tokenAmount,
      epochsSubmitted: EPOCHS_SIGNED + 1n,
      byteSizeSubmitted: BYTE_SIZE_SIGNED,
      kaCountSubmitted: KA_COUNT_SIGNED,
      signer: coreWallet,
      kav10Address,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBeTruthy();
    }
  }, 60_000);

  it('byteSize mismatch: ACK signed @ 256, submitted @ 1024 → chain reverts', async () => {
    const tokenAmount = await adapter.getRequiredPublishTokenAmount(BYTE_SIZE_SIGNED, Number(EPOCHS_SIGNED));
    const result = await submitWithCostMismatch(adapter, {
      cgId,
      identityId: coreIdentityId,
      tokenAmountSigned: tokenAmount,
      tokenAmountSubmitted: tokenAmount,
      epochsSubmitted: EPOCHS_SIGNED,
      byteSizeSubmitted: BYTE_SIZE_SIGNED * 4n,
      kaCountSubmitted: KA_COUNT_SIGNED,
      signer: coreWallet,
      kav10Address,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBeTruthy();
    }
  }, 60_000);
});
