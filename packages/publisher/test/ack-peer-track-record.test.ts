import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { computePublishACKDigest, encodeStorageACK } from '@origintrail-official/dkg-core';
import { ACKCollector, type ACKCollectorDeps, type CollectedACK } from '../src/ack-collector.js';
import { PeerStatusLedger, type ACKPeerOutcomeReport } from '../src/ack-peer-status-ledger.js';
import { ACKPeerTrackRecord, ACK_PEER_TRACK_RECORD_TTL_MS } from '../src/ack-peer-track-record.js';
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

function ack(peerId: string): CollectedACK {
  return { peerId, signatureR: new Uint8Array(32), signatureVS: new Uint8Array(32), nodeIdentityId: 1n };
}

describe('PeerStatusLedger round outcomes', () => {
  it('reports each asked core once, with the latency of a counted ACK', () => {
    let now = 1_000;
    const ledger = new PeerStatusLedger(() => now);
    now = 1_250;
    ledger.recordACK(ack('fast'));
    ledger.recordSignerFailure('non-member', 'not-in-sharding-table');
    ledger.recordSignerFailure('stale-key', 'key-not-registered');
    ledger.recordSignerFailure('rpc', 'rpc-error');
    ledger.recordACKValidation('forger', 'INVALID_SIGNATURE');
    ledger.recordStorageDecline('busy', 'CORE_TEMPORARILY_UNAVAILABLE', 'store saturated');
    ledger.recordProtocolUnsupported('old', 'no handler');
    ledger.recordTransportError('silent', 'timed out');

    const reports: ACKPeerOutcomeReport[] = [];
    const counts = ledger.settle(
      ['fast', 'non-member', 'stale-key', 'rpc', 'forger', 'busy', 'old', 'silent', 'pending'],
      (seen) => { reports.push(...seen); },
    );

    expect(reports).toEqual([
      { peerId: 'fast', outcome: { kind: 'valid', latencyMs: 250 } },
      { peerId: 'non-member', outcome: { kind: 'ineligible-signer', reason: 'not-in-sharding-table' } },
      { peerId: 'stale-key', outcome: { kind: 'ineligible-signer', reason: 'key-not-registered' } },
      { peerId: 'forger', outcome: { kind: 'declined', code: 'INVALID_SIGNATURE' } },
      { peerId: 'busy', outcome: { kind: 'declined', code: 'CORE_TEMPORARILY_UNAVAILABLE' } },
      { peerId: 'old', outcome: { kind: 'declined', code: 'PROTOCOL_UNSUPPORTED' } },
      { peerId: 'silent', outcome: { kind: 'unanswered' } },
    ]);
    expect(counts).toEqual({ total: 9, ack: 1, declined: 1, invalid: 4, unsupported: 1, transport: 1, pending: 1 });
  });

  it('keeps the counts when the observer throws', () => {
    const ledger = new PeerStatusLedger();
    ledger.recordACK(ack('fast'));
    expect(ledger.settle(['fast'], () => { throw new Error('observer failed'); }))
      .toMatchObject({ total: 1, ack: 1 });
  });
});

describe('ACKPeerTrackRecord', () => {
  const valid = (latencyMs: number) => ({ kind: 'valid' as const, latencyMs });

  it('leaves out a core whose signer the chain put outside the sharding table', () => {
    const record = new ACKPeerTrackRecord();
    record.record([
      { peerId: 'b', outcome: valid(400) },
      { peerId: 'n', outcome: { kind: 'ineligible-signer', reason: 'not-in-sharding-table' } },
    ]);
    const plan = record.plan(['n', 'a', 'b', 'c'], 2);
    expect(plan.peers).toEqual(['b', 'a', 'c']);
    expect([...plan.ineligible]).toEqual(['n']);
  });

  it('keeps such a core while leaving it out would leave fewer candidates than the quorum', () => {
    const record = new ACKPeerTrackRecord();
    record.record([{ peerId: 'n', outcome: { kind: 'ineligible-signer', reason: 'not-in-sharding-table' } }]);
    const plan = record.plan(['n', 'a'], 2);
    expect(plan.peers).toEqual(['a', 'n']);
    expect(plan.ineligible.size).toBe(0);
  });

  it('asks recent fast valid cores first, unknown ones next, declined or silent ones last', () => {
    const record = new ACKPeerTrackRecord();
    record.record([
      { peerId: 'slow', outcome: valid(900) },
      { peerId: 'busy', outcome: { kind: 'declined', code: 'CORE_TEMPORARILY_UNAVAILABLE' } },
      { peerId: 'fast', outcome: valid(150) },
      { peerId: 'silent', outcome: { kind: 'unanswered' } },
    ]);
    expect(record.plan(['busy', 'silent', 'unknown-1', 'slow', 'fast', 'unknown-2'], 2).peers)
      .toEqual(['fast', 'slow', 'unknown-1', 'unknown-2', 'busy', 'silent']);
  });

  it('forgets an outcome after the TTL, so a core that joined the sharding table is asked again', () => {
    let now = 0;
    const record = new ACKPeerTrackRecord(() => now);
    record.record([{ peerId: 'n', outcome: { kind: 'ineligible-signer', reason: 'not-in-sharding-table' } }]);
    now = ACK_PEER_TRACK_RECORD_TTL_MS - 1;
    expect(record.plan(['n', 'a', 'b'], 2).peers).toEqual(['a', 'b']);
    now = ACK_PEER_TRACK_RECORD_TTL_MS;
    expect(record.plan(['n', 'a', 'b'], 2).peers).toEqual(['n', 'a', 'b']);
    expect(record.outcome('n')).toBeUndefined();
  });

  it('replaces a core\'s outcome with its newest and bounds how many cores it keeps', () => {
    const record = new ACKPeerTrackRecord(Date.now, ACK_PEER_TRACK_RECORD_TTL_MS, 2);
    record.record([{ peerId: 'a', outcome: { kind: 'unanswered' } }]);
    record.record([{ peerId: 'a', outcome: valid(10) }, { peerId: 'b', outcome: valid(20) }]);
    record.record([{ peerId: 'c', outcome: valid(30) }]);
    expect(record.outcome('a')).toBeUndefined();
    expect(record.outcome('b')).toEqual(valid(20));
    expect(record.outcome('c')).toEqual(valid(30));
  });
});

/**
 * The testnet pool of 13 Nov 2026 and 19 Nov 2026 as one model: two cores that
 * answer fast, one whose signer is not in the sharding table, one that declines
 * while its store is busy, one that is slow. Quorum 2.
 */
describe('ACK rounds with the track record', () => {
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

  /** One round over the pool; `plan` stands in for the agent's candidate selection. */
  async function round(plan: (pool: string[]) => string[], record?: ACKPeerTrackRecord) {
    const sends: string[] = [];
    const checks: bigint[] = [];
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sleep: async () => { await sleep(1_000); },
      sendP2P: async (peerId) => {
        sends.push(peerId);
        await sleep(replyAfterMs.get(peerId)!);
        return peerId === 'busy' ? decline() : signedACK(peerId);
      },
      getConnectedCorePeers: async () => plan([...wallets.keys()]),
      verifyIdentityDetailed: async (_signer, identityId) => {
        checks.push(identityId);
        await sleep(20);
        return identityId === 19n ? { valid: false, reason: 'not-in-sharding-table' } : { valid: true };
      },
      ...(record ? { onPeerOutcomes: (reports: readonly ACKPeerOutcomeReport[]) => record.record(reports) } : {}),
    };
    const startedAt = performance.now();
    const result = await new ACKCollector(deps).collect({
      merkleRoot, contextGraphId: CG_ID, contextGraphIdStr: CG_STR, publisherPeerId: 'edge', publicByteSize: 100n,
      isPrivate: false, kaCount: 1, rootEntities: ['urn:a'], chainId: CHAIN_ID, kav10Address: KAV10,
      merkleLeafCount, ackMode: { kind: 'public' }, requiredACKs: 2,
    });
    return { ms: performance.now() - startedAt, sends, checks, acks: result.acks.map((a) => a.peerId) };
  }

  it('stops asking the non-member after one round, and asks it every round without the record', async () => {
    const asIs = (pool: string[]) => pool;
    const before = [await round(asIs), await round(asIs)];

    const record = new ACKPeerTrackRecord();
    const planned = (pool: string[]) => record.plan(pool, 2).peers;
    const after = [await round(planned, record), await round(planned, record)];

    for (const r of [...before, ...after]) expect(r.acks.sort()).toEqual(['fast-1', 'fast-2']);
    // Before: every round asks all five cores and checks the non-member's signer on chain.
    expect(before.map((r) => r.sends.length)).toEqual([5, 5]);
    expect(before.map((r) => r.checks.length)).toEqual([3, 3]);
    // After: the first round learns; the second asks four, fast ones first, and checks only the two that count.
    expect(after[0]).toMatchObject({ sends: ['fast-1', 'fast-2', 'non-member', 'busy', 'slow'] });
    expect(after[1].sends).toEqual(['fast-1', 'fast-2', 'slow', 'busy']);
    expect(after[1].checks).toEqual([3n, 4n]);
    expect(record.outcome('non-member')).toEqual({ kind: 'ineligible-signer', reason: 'not-in-sharding-table' });
    expect(record.outcome('busy')).toEqual({ kind: 'declined', code: 'CORE_TEMPORARILY_UNAVAILABLE' });
  });
});
