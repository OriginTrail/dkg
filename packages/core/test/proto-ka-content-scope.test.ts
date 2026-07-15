import { describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  decodeFinalizationMessage,
  decodeKAUpdateRequest,
  decodePublishIntent,
  decodePublishRequest,
  decodeSharePublishRequest,
  decodeUpdateIntent,
  encodeFinalizationMessage,
  encodeKAUpdateRequest,
  encodePublishIntent,
  encodePublishRequest,
  encodeSharePublishRequest,
  encodeUpdateIntent,
} from '../src/index.js';

const UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';
const PRIVATE_ROOT = new Uint8Array(32).fill(0x42);

function expectGraphScope(
  decoded: {
    contentScopeVersion?: number;
    assertionVersion?: string;
    publicTripleCount?: number;
    privateMerkleRoot?: Uint8Array;
    privateTripleCount?: number;
  },
): void {
  expect(decoded.contentScopeVersion).toBe(GRAPH_KA_CONTENT_SCOPE_VERSION);
  expect(decoded.assertionVersion).toBe('2');
  expect(decoded.publicTripleCount).toBe(1_000);
  expect(new Uint8Array(decoded.privateMerkleRoot ?? [])).toEqual(PRIVATE_ROOT);
  expect(decoded.privateTripleCount).toBe(11);
}

describe('rootless KA graph scope wire contract', () => {
  it('round-trips one KA scope through SWM share gossip', () => {
    const decoded = decodeSharePublishRequest(encodeSharePublishRequest({
      contextGraphId: 'private-cg',
      nquads: new TextEncoder().encode('<urn:s> <urn:p> "value" .'),
      manifest: [],
      publisherPeerId: '12D3KooWPublisher',
      shareOperationId: 'share-1',
      timestampMs: 1,
      agentAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      kaNumber: '7',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: '2',
      publicTripleCount: 1_000,
      privateMerkleRoot: PRIVATE_ROOT,
      privateTripleCount: 11,
    }));

    expect(decoded.kaUal).toBe(UAL);
    expect(decoded.manifest).toEqual([]);
    expectGraphScope(decoded);
  });

  it('round-trips one KA scope through publish ACK intent', () => {
    const decoded = decodePublishIntent(encodePublishIntent({
      merkleRoot: new Uint8Array(32).fill(0x11),
      contextGraphId: '42',
      publisherPeerId: '12D3KooWPublisher',
      publicByteSize: 12_345,
      isPrivate: true,
      kaCount: 1,
      rootEntities: [],
      privateMerkleRoots: [],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: '2',
      publicTripleCount: 1_000,
      privateMerkleRoot: PRIVATE_ROOT,
      privateTripleCount: 11,
    }));

    expect(decoded.kaUal).toBe(UAL);
    expect(decoded.rootEntities).toEqual([]);
    expect(decoded.privateMerkleRoots).toEqual([]);
    expectGraphScope(decoded);
  });

  it('round-trips one KA scope through finalization gossip', () => {
    const decoded = decodeFinalizationMessage(encodeFinalizationMessage({
      ual: UAL,
      contextGraphId: 'private-cg',
      kcMerkleRoot: new Uint8Array(32).fill(0x11),
      txHash: '0xabc',
      blockNumber: 10,
      batchId: 7,
      startKAId: 7,
      endKAId: 7,
      publisherAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      rootEntities: [],
      timestampMs: 2,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      assertionVersion: '2',
      publicTripleCount: 1_000,
      privateMerkleRoot: PRIVATE_ROOT,
      privateTripleCount: 11,
    }));

    expect(decoded.ual).toBe(UAL);
    expect(decoded.rootEntities).toEqual([]);
    expectGraphScope(decoded);
  });

  it('round-trips one KA scope through receiving-node publish', () => {
    const decoded = decodePublishRequest(encodePublishRequest({
      ual: UAL,
      nquads: new TextEncoder().encode('<urn:s> <urn:p> "value" .'),
      contextGraphId: 'private-cg',
      kas: [],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      startKAId: 7,
      endKAId: 7,
      chainId: 'base:8453',
      publisherSignatureR: new Uint8Array(32),
      publisherSignatureVs: new Uint8Array(32),
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      assertionVersion: '2',
      publicTripleCount: 1_000,
      privateMerkleRoot: PRIVATE_ROOT,
      privateTripleCount: 11,
    }));

    expect(decoded.ual).toBe(UAL);
    expect(decoded.kas).toEqual([]);
    expectGraphScope(decoded);
  });

  it('round-trips one KA scope through update gossip', () => {
    const decoded = decodeKAUpdateRequest(encodeKAUpdateRequest({
      contextGraphId: 'private-cg',
      batchId: 7,
      nquads: new TextEncoder().encode('<urn:s> <urn:p> "updated" .'),
      manifest: [],
      publisherPeerId: '12D3KooWPublisher',
      publisherAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      txHash: '0xdef',
      blockNumber: 10,
      newMerkleRoot: new Uint8Array(32).fill(0x11),
      timestampMs: 3,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: '2',
      publicTripleCount: 1_000,
      privateMerkleRoot: PRIVATE_ROOT,
      privateTripleCount: 11,
    }));

    expect(decoded.kaUal).toBe(UAL);
    expect(decoded.manifest).toEqual([]);
    expectGraphScope(decoded);
  });

  it('round-trips one KA scope through update ACK intent', () => {
    const decoded = decodeUpdateIntent(encodeUpdateIntent({
      kaId: '7',
      contextGraphId: '42',
      preUpdateMerkleRootCount: 1,
      newMerkleRoot: new Uint8Array(32).fill(0x11),
      newByteSize: 12_345,
      newTokenAmount: '1',
      newMerkleLeafCount: 1_001,
      publisherPeerId: '12D3KooWPublisher',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: '2',
      publicTripleCount: 1_000,
      privateMerkleRoot: PRIVATE_ROOT,
      privateTripleCount: 11,
    }));

    expect(decoded.kaUal).toBe(UAL);
    expectGraphScope(decoded);
  });

  it('keeps archived root messages distinguishable by absent scope version', () => {
    const decoded = decodeSharePublishRequest(encodeSharePublishRequest({
      contextGraphId: 'legacy-cg',
      nquads: new Uint8Array(),
      manifest: [{ rootEntity: 'urn:legacy:entity', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWLegacy',
      shareOperationId: 'legacy-share',
      timestampMs: 1,
    }));

    expect(decoded.contentScopeVersion).toBeUndefined();
    expect(decoded.kaUal).toBeUndefined();
    expect(decoded.manifest[0].rootEntity).toBe('urn:legacy:entity');
  });
});
