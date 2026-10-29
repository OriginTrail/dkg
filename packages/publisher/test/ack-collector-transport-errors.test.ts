import { describe, it, expect } from 'vitest';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { QuorumUnmetError } from '../src/ack-errors.js';
import { PooledStreamResetError } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, computeFlatKCMerkleLeafCountV10 } from '../src/merkle.js';

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';
const testCGId = 42n;
const testCGIdStr = 'test-cg';
const quads = ['urn:o1', 'urn:o2'].map(object => ({
  subject: 'urn:a', predicate: 'urn:p', object, graph: 'urn:test',
}));
const merkleRoot = computeFlatKCRootV10(quads, []);
const merkleLeafCount = computeFlatKCMerkleLeafCountV10(quads, []);

describe('ACKCollector transport errors', () => {
  // A peer that refuses the ACK protocol is settled as PROTOCOL_UNSUPPORTED
  // after exactly one send, never retried as a transport error. The refusal is
  // recognised in three shapes: the multistream-select negotiation message, a
  // libp2p typed error name under different wording, and (through the pooled
  // wire's wrapper) a typed refusal carried as the `cause`. Only how the error
  // is built differs between the cases.
  it.each<[label: string, makeError: (protocol: string) => Error]>([
    [
      'a negotiation-message refusal',
      (protocol) => new Error(`Protocol selection failed - could not negotiate ${protocol}`),
    ],
    [
      'a typed UnsupportedProtocolError with different wording',
      () => {
        const err = new Error('the remote declined every offered protocol');
        err.name = 'UnsupportedProtocolError';
        return err;
      },
    ],
    [
      'a pooled-wire reset that wraps a typed refusal as its cause',
      () => {
        const refusal = new Error('nothing to see here');
        refusal.name = 'UnsupportedProtocolError';
        return new PooledStreamResetError('open failed', { cause: refusal });
      },
    ],
  ])('does not retry a peer that cannot negotiate the required ACK protocol: %s', async (_label, makeError) => {
    const callsByPeer = new Map<string, number>();
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sleep: async () => {},
      sendP2P: async (peerId, protocol) => {
        callsByPeer.set(peerId, (callsByPeer.get(peerId) ?? 0) + 1);
        throw makeError(protocol);
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    let caught: QuorumUnmetError | undefined;
    try {
      await collector.collect({
        merkleRoot,
        contextGraphId: testCGId,
        contextGraphIdStr: testCGIdStr,
        publisherPeerId: 'publisher-0',
        publicByteSize: 100n,
        isPrivate: false,
        kaCount: 1,
        rootEntities: ['urn:a'],
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
        merkleLeafCount,
        ackMode: { kind: 'public' },
      });
    } catch (err) {
      caught = err as QuorumUnmetError;
    }

    expect(caught).toBeDefined();
    expect(caught).toMatchObject({
      peerOutcomes: expect.arrayContaining([
        expect.objectContaining({
          dialOk: true,
          protocolSupported: false,
          reason: 'PROTOCOL_UNSUPPORTED',
        }),
      ]),
    });
    expect(caught!.message).toContain('storage_ack_insufficient');
    expect(caught!.message).toContain('PROTOCOL_UNSUPPORTED');

    for (const peerId of ['peer-0', 'peer-1', 'peer-2']) {
      expect(callsByPeer.get(peerId)).toBe(1);
    }
  });
});
