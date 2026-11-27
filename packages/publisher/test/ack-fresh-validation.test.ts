import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { computePublishACKDigest, encodeStorageACK } from '@origintrail-official/dkg-core';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { computeFlatKCMerkleLeafCountV10, computeFlatKCRootV10 } from '../src/merkle.js';

const CHAIN_ID = 31337n;
const KAV10 = '0x000000000000000000000000000000000000c10a';
const CG_ID = 1217n;
const CG_STR = 'vm-smoke';
const quads = [
  { subject: 'urn:a', predicate: 'urn:p', object: 'urn:o1', graph: 'urn:test' },
  { subject: 'urn:a', predicate: 'urn:p', object: 'urn:o2', graph: 'urn:test' },
];
const merkleRoot = computeFlatKCRootV10(quads, []);
const merkleLeafCount = computeFlatKCMerkleLeafCountV10(quads, []);

/**
 * The testnet pool of 13 Nov 2026 and 19 Nov 2026 as one model: two cores that
 * answer fast, one whose signer is not in the sharding table, one that declines
 * while its store is busy, one that is slow. Quorum 2.
 */
describe('ACK rounds verify every candidate afresh', () => {
  const wallets = new Map(['fast-1', 'fast-2', 'non-member', 'busy', 'slow'].map((peerId) => [peerId, ethers.Wallet.createRandom()]));
  const identity = new Map([['fast-1', 3n], ['fast-2', 4n], ['non-member', 19n], ['busy', 6n], ['slow', 7n]]);
  // The non-member answers first, so its rejection always lands before the quorum.
  const replyAfterMs = new Map([['fast-1', 40], ['fast-2', 60], ['non-member', 10], ['busy', 30], ['slow', 400]]);
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function signedACK(peerId: string): Promise<Uint8Array> {
    const digest = computePublishACKDigest(CHAIN_ID, KAV10, CG_ID, merkleRoot, 1n, 100n, 1n, 0n, BigInt(merkleLeafCount));
    const sig = ethers.Signature.from(await wallets.get(peerId)!.signMessage(digest));
    return encodeStorageACK({
      merkleRoot,
      coreNodeSignatureR: ethers.getBytes(sig.r),
      coreNodeSignatureVS: ethers.getBytes(sig.yParityAndS),
      contextGraphId: CG_STR,
      nodeIdentityId: Number(identity.get(peerId)!),
    });
  }

  function decline(): Uint8Array {
    return encodeStorageACK({
      merkleRoot: new Uint8Array(), coreNodeSignatureR: new Uint8Array(), coreNodeSignatureVS: new Uint8Array(),
      contextGraphId: CG_STR, nodeIdentityId: 0,
      declineCode: 'CORE_TEMPORARILY_UNAVAILABLE', declineMessage: 'store saturated',
    });
  }

  function createRounds(legacy = false) {
    let options: { pool?: string[]; recovered?: boolean } = {};
    const sends: string[] = [], checks: bigint[] = [];
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sleep: async () => { await sleep(1_000); },
      sendP2P: async (peerId) => {
        sends.push(peerId);
        await sleep(replyAfterMs.get(peerId)!);
        return peerId === 'busy' ? decline() : signedACK(peerId);
      },
      getConnectedCorePeers: async () => options.pool ?? [...wallets.keys()],
      verifyIdentityDetailed: async (_signer, identityId) => {
        checks.push(identityId);
        await sleep(20);
        return identityId === 19n && !options.recovered ? { valid: false, reason: 'not-in-sharding-table' } : { valid: true };
      },
    };
    if (legacy) {
      delete deps.verifyIdentityDetailed;
      deps.verifyIdentity = async (_signer, identityId) => {
        checks.push(identityId);
        return !(!options.recovered && identityId === 19n);
      };
    }
    // Production providers retain their collector. Reuse it across changed authority answers.
    const collector = new ACKCollector(deps);
    return async (next: typeof options = {}) => {
      options = next;
      const sendOffset = sends.length, checkOffset = checks.length;
      const result = await collector.collect({
        merkleRoot, contextGraphId: CG_ID, contextGraphIdStr: CG_STR, publisherPeerId: 'edge', publicByteSize: 100n,
        isPrivate: false, kaCount: 1, rootEntities: ['urn:a'], chainId: CHAIN_ID, kav10Address: KAV10,
        merkleLeafCount, ackMode: { kind: 'public' }, requiredACKs: 2,
      });
      return { sends: sends.slice(sendOffset), checks: checks.slice(checkOffset), acks: result.acks.map(a => a.peerId) };
    };
  }

  it('requests the same complete pool and freshly verifies signers in consecutive rounds', async () => {
    const round = createRounds();
    const rounds = [await round(), await round()];
    for (const result of rounds) {
      expect(result.sends).toEqual([...wallets.keys()]);
      expect(result.checks).toEqual([19n, 3n, 4n]);
      expect(result.acks.sort()).toEqual(['fast-1', 'fast-2']);
    }
  });

  it.each([false, true])('counts a recovered signer after an earlier rejection (legacy=%s)', async legacy => {
    const round = createRounds(legacy);
    const first = await round();
    expect(first.checks).toContain(19n);
    expect(first.acks).not.toContain('non-member');
    const result = await round({ recovered: true, pool: ['non-member', 'busy', 'fast-2'] });
    expect(result.sends).toEqual(['non-member', 'busy', 'fast-2']);
    expect(result.checks).toEqual([19n, 4n]);
    expect(result.acks.sort()).toEqual(['fast-2', 'non-member']);
  });
});
