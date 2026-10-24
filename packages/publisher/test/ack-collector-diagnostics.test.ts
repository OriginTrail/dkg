import { describe, expect, it } from 'vitest';
import { ACKCollector } from '../src/ack-collector.js';
import { computeFlatKCRootV10, computeFlatKCMerkleLeafCountV10 } from '../src/merkle.js';

const TEST_CHAIN_ID = 31337n;
const testCGId = 42n;
const testCGIdStr = 'test-cg';
const testQuads = [
  { subject: 'urn:a', predicate: 'urn:p', object: 'urn:o1', graph: 'urn:test' },
  { subject: 'urn:a', predicate: 'urn:p', object: 'urn:o2', graph: 'urn:test' },
];
const merkleRoot = computeFlatKCRootV10(testQuads, []);
const merkleLeafCount = computeFlatKCMerkleLeafCountV10(testQuads, []);

describe('ACKCollector diagnostic settlement', () => {
  it.each(['publish', 'update'] as const)('reports discovered unattempted candidates on early %s quorum failure', async operation => {
    const events: unknown[] = [];
    let sends = 0;
    const collector = new ACKCollector({
      gossipPublish: async () => {},
      sendP2P: async () => { sends++; throw new Error('must not dial an impossible quorum'); },
      getConnectedCorePeers: () => ['candidate-a', 'candidate-b'],
    });
    const onDiagnostic = (event: unknown) => { events.push(event); };
    // An invalid digest address proves the candidate guard still wins first.
    const attempt = operation === 'publish'
      ? collector.collect({ merkleRoot, contextGraphId: testCGId, contextGraphIdStr: testCGIdStr,
          publisherPeerId: 'publisher', publicByteSize: 100n, isPrivate: false, kaCount: 1,
          rootEntities: ['urn:a'], chainId: TEST_CHAIN_ID, kav10Address: 'invalid-before-digest',
          merkleLeafCount, ackMode: { kind: 'public' }, requiredACKs: 3, onDiagnostic })
      : collector.collectUpdate({ kaId: 1n, contextGraphId: testCGId, preUpdateMerkleRootCount: 1n,
          newMerkleRoot: merkleRoot, newByteSize: 100n, newTokenAmount: 1n, mintAmount: 0n,
          burnTokenIds: [], newMerkleLeafCount: merkleLeafCount, chainId: TEST_CHAIN_ID,
          kav10Address: 'invalid-before-digest', publisherPeerId: 'publisher', requiredACKs: 3, onDiagnostic });
    await expect(attempt).rejects.toMatchObject({ collected: 0, required: 3, dialled: 2,
      peerOutcomes: [ { peerId: 'candidate-a', reason: 'pool_below_quorum' },
        { peerId: 'candidate-b', reason: 'pool_below_quorum' } ] });
    expect(sends).toBe(0);
    expect(events).toEqual([expect.objectContaining({ completedPeerAttempts: 0, perRoundPeakPeerRequests: 0,
      candidates: { total: 2, ack: 0, declined: 0, invalid: 0, unsupported: 0, transport: 0, pending: 2 } })]);
  });

  it.each(['publish', 'update'] as const)('settles one immutable summary when %s digest construction fails before dialing', async operation => {
    const events: unknown[] = [];
    let sends = 0;
    const collector = new ACKCollector({
      gossipPublish: async () => {},
      sendP2P: async () => { sends++; throw new Error('must not dial an impossible quorum'); },
      getConnectedCorePeers: () => ['candidate-a', 'candidate-b', 'candidate-c'],
    });
    const onDiagnostic = (event: unknown) => { events.push(event); throw new Error('observer must not mask digest failure'); };
    const attempt = operation === 'publish'
      ? collector.collect({ merkleRoot, contextGraphId: testCGId, contextGraphIdStr: testCGIdStr,
          publisherPeerId: 'publisher', publicByteSize: 100n, isPrivate: false, kaCount: 1,
          rootEntities: ['urn:a'], chainId: TEST_CHAIN_ID, kav10Address: 'invalid-before-digest',
          merkleLeafCount, ackMode: { kind: 'public' }, requiredACKs: 3, onDiagnostic })
      : collector.collectUpdate({ kaId: 1n, contextGraphId: testCGId, preUpdateMerkleRootCount: 1n,
          newMerkleRoot: merkleRoot, newByteSize: 100n, newTokenAmount: 1n, mintAmount: 0n,
          burnTokenIds: [], newMerkleLeafCount: merkleLeafCount, chainId: TEST_CHAIN_ID,
          kav10Address: 'invalid-before-digest', publisherPeerId: 'publisher', requiredACKs: 3, onDiagnostic });
    await expect(attempt).rejects.toThrow('kav10Address must be a 0x-prefixed 20-byte hex string');
    expect(sends).toBe(0);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(events).toEqual([expect.objectContaining({ completedPeerAttempts: 0, perRoundPeakPeerRequests: 0,
      candidates: { total: 3, ack: 0, declined: 0, invalid: 0, unsupported: 0, transport: 0, pending: 3 } })]);
  });

});
