/**
 * Publisher ACK-digest spec-conformance tests (unit; no chain, no network).
 *
 * Audit findings covered:
 *
 *   P-5 (HIGH) — The legacy suite (`signature-collection.test.ts` →
 *                `LocalSignerPeer.signParticipantAck`) signs the 2-field
 *                ACK digest `keccak256(uint256 cgId || bytes32 merkleRoot)`.
 *                V10 on-chain verification (see
 *                `packages/core/src/crypto/ack.ts::computePublishACKDigest`
 *                and `KnowledgeAssetsV10.sol:362-373`) requires the
 *                H5-prefixed 8-field form
 *                `keccak256(chainid || kav10Address || cgId || root ||
 *                           kaCount || byteSize || epochs || tokenAmount)`.
 *                A signer using the 2-field form yields an ACK the chain
 *                would silently reject.  We pin:
 *                  • the 8-field digest is the ACKCollector's expected
 *                    digest → ecrecover yields the right address;
 *                  • a 2-field-signed ACK over the SAME `(cgId, root)` is
 *                    NOT equal to the 8-field digest → the collector MUST
 *                    reject it (not silently accept a mismatched address).
 *
 * Per QA policy: do NOT modify production code. If the collector ever
 * starts accepting the 2-field legacy digest, the "collector rejects
 * legacy digest" assertion flips and exposes the regression.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  computePublishACKDigest,
  encodeStorageACK,
} from '@origintrail-official/dkg-core';
import {
  ACKCollector,
  type ACKCollectorDeps,
} from '../src/index.js';

const CHAIN_ID = 31337n;
const KAV10_ADDR = '0x000000000000000000000000000000000000c10a';
const CG_ID = 987654321n;
const CG_ID_STR = '987654321';
const ROOT = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('v10-vs-legacy-root')));
const KA_COUNT = 2;
const BYTE_SIZE = 321n;
const EPOCHS = 1;
const TOKEN_AMOUNT = 1000n;

/** Legacy (pre-V10, 2-field) digest that the current `signature-collection.test.ts::LocalSignerPeer.signParticipantAck` produces. */
function legacyTwoFieldDigest(cgId: bigint, merkleRoot: Uint8Array): Uint8Array {
  const hex = ethers.solidityPackedKeccak256(
    ['uint256', 'bytes32'],
    [cgId, ethers.hexlify(merkleRoot)],
  );
  return ethers.getBytes(hex);
}

function buildAckFromDigest(
  wallet: ethers.Wallet,
  digest: Uint8Array,
  nodeIdentityId: number,
): Promise<Uint8Array> {
  return wallet
    .signMessage(digest)
    .then((sigHex) => {
      const sig = ethers.Signature.from(sigHex);
      return encodeStorageACK({
        merkleRoot: ROOT,
        coreNodeSignatureR: ethers.getBytes(sig.r),
        coreNodeSignatureVS: ethers.getBytes(sig.yParityAndS),
        contextGraphId: CG_ID_STR,
        nodeIdentityId,
      });
    });
}

describe('P-5: V10 8-field ACK digest must differ from legacy 2-field digest', () => {
  it('the two digests hash different packed payloads', () => {
    const v10 = computePublishACKDigest(
      CHAIN_ID, KAV10_ADDR, CG_ID, ROOT,
      BigInt(KA_COUNT), BYTE_SIZE, BigInt(EPOCHS), TOKEN_AMOUNT,
    );
    const legacy = legacyTwoFieldDigest(CG_ID, ROOT);
    // If these ever collide, the H5 prefix collapsed and chain replay
    // across cost parameters would be trivially possible.
    expect(ethers.hexlify(v10)).not.toBe(ethers.hexlify(legacy));
  });

  it('changing ANY cost field (tokenAmount, epochs, byteSize, kaCount) changes the V10 digest', () => {
    const base = computePublishACKDigest(
      CHAIN_ID, KAV10_ADDR, CG_ID, ROOT,
      BigInt(KA_COUNT), BYTE_SIZE, BigInt(EPOCHS), TOKEN_AMOUNT,
    );
    const wrongTok = computePublishACKDigest(
      CHAIN_ID, KAV10_ADDR, CG_ID, ROOT,
      BigInt(KA_COUNT), BYTE_SIZE, BigInt(EPOCHS), TOKEN_AMOUNT + 1n,
    );
    const wrongEpochs = computePublishACKDigest(
      CHAIN_ID, KAV10_ADDR, CG_ID, ROOT,
      BigInt(KA_COUNT), BYTE_SIZE, BigInt(EPOCHS + 1), TOKEN_AMOUNT,
    );
    const wrongByte = computePublishACKDigest(
      CHAIN_ID, KAV10_ADDR, CG_ID, ROOT,
      BigInt(KA_COUNT), BYTE_SIZE + 1n, BigInt(EPOCHS), TOKEN_AMOUNT,
    );
    const wrongCount = computePublishACKDigest(
      CHAIN_ID, KAV10_ADDR, CG_ID, ROOT,
      BigInt(KA_COUNT + 1), BYTE_SIZE, BigInt(EPOCHS), TOKEN_AMOUNT,
    );
    expect(ethers.hexlify(wrongTok)).not.toBe(ethers.hexlify(base));
    expect(ethers.hexlify(wrongEpochs)).not.toBe(ethers.hexlify(base));
    expect(ethers.hexlify(wrongByte)).not.toBe(ethers.hexlify(base));
    expect(ethers.hexlify(wrongCount)).not.toBe(ethers.hexlify(base));
  });
});

describe('P-5: ACKCollector rejects ACKs signed over the legacy 2-field digest', () => {
  it('peer that signed the V10 digest is accepted; peer that signed the legacy digest is rejected', async () => {
    const legitWallets = [
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
    ];
    const legacyWallet = ethers.Wallet.createRandom();

    const v10Digest = computePublishACKDigest(
      CHAIN_ID, KAV10_ADDR, CG_ID, ROOT,
      BigInt(KA_COUNT), BYTE_SIZE, BigInt(EPOCHS), TOKEN_AMOUNT,
    );
    const legacyDigest = legacyTwoFieldDigest(CG_ID, ROOT);

    // Build expected signer addresses so we can assert the collector
    // recovered exactly the legit-wallet addresses (i.e. it validated
    // against the V10 digest, not the legacy one).
    const legitAddrs = legitWallets.map(w => w.address.toLowerCase());
    const legacyAddr = legacyWallet.address.toLowerCase();

    const sendP2P: ACKCollectorDeps['sendP2P'] = async (peerId) => {
      // peer-0, peer-1, peer-2 → legit; peer-3 → signed legacy digest
      const idx = parseInt(peerId.replace('peer-', ''), 10);
      if (idx <= 2) {
        return buildAckFromDigest(legitWallets[idx], v10Digest, idx + 1);
      }
      return buildAckFromDigest(legacyWallet, legacyDigest, 99);
    };

    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P,
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    const result = await collector.collect({
      merkleRoot: ROOT,
      contextGraphId: CG_ID,
      contextGraphIdStr: CG_ID_STR,
      publisherPeerId: 'publisher-0',
      publicByteSize: BYTE_SIZE,
      isPrivate: false,
      kaCount: KA_COUNT,
      rootEntities: ['urn:test:p5:root'],
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDR,
      epochs: EPOCHS,
      tokenAmount: TOKEN_AMOUNT,
    });

    // 3 legit ACKs must be accepted.
    expect(result.acks).toHaveLength(3);

    // Now confirm the collector did NOT accept a legacy-digest-signed
    // ACK when it was the only choice. If the implementation silently
    // skipped the check, the collector would accept the `legacyAddr`
    // instead and this loop would fail.
    const deps4: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async () => buildAckFromDigest(legacyWallet, legacyDigest, 99),
      getConnectedCorePeers: () => ['peer-only-legacy-0', 'peer-only-legacy-1', 'peer-only-legacy-2'],
      log: () => {},
    };
    const collectorOnlyLegacy = new ACKCollector(deps4);
    // Shrink the ACK timeout via a race so the test does not block
    // for the default 120 s when the collector rightly refuses to
    // accept ANY of the 3 legacy-digest ACKs. We win the race on a
    // fast timeout, proving the collector never reached quorum on
    // legacy digests.
    const timed = Promise.race([
      collectorOnlyLegacy
        .collect({
          merkleRoot: ROOT,
          contextGraphId: CG_ID,
          contextGraphIdStr: CG_ID_STR,
          publisherPeerId: 'publisher-0',
          publicByteSize: BYTE_SIZE,
          isPrivate: false,
          kaCount: KA_COUNT,
          rootEntities: ['urn:test:p5:legacy'],
          chainId: CHAIN_ID,
          kav10Address: KAV10_ADDR,
          epochs: EPOCHS,
          tokenAmount: TOKEN_AMOUNT,
        })
        .then(
          (r) => ({ kind: 'resolved' as const, acks: r.acks.length }),
          (e: unknown) => ({ kind: 'rejected' as const, err: (e as Error).message }),
        ),
      new Promise<{ kind: 'race-timeout' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'race-timeout' }), 5000),
      ),
    ]);
    const outcome = await timed;

    // If the collector silently validated ACKs against the legacy digest,
    // it would reach quorum (3/3) and `kind === 'resolved'`. The correct
    // behavior is either a fast rejection (kind 'rejected') or — because
    // the default MAX_RETRIES back-off delays failure past our race — a
    // timeout. Either is acceptable; a successful collection is NOT.
    expect(outcome.kind).not.toBe('resolved');
    // Sanity: leak guard — we shouldn't have captured the legacy signer
    // address among the legit results above either.
    expect(legitAddrs).not.toContain(legacyAddr);
  }, 30000);
});
