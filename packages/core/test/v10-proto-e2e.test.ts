import { describe, it, expect } from 'vitest';
import {
  encodeVerifyProposal,
  decodeVerifyProposal,
  encodeVerifyApproval,
  decodeVerifyApproval,
  encodeStorageACK,
  decodeStorageACK,
  encodeGossipEnvelope,
  decodeGossipEnvelope,
  computeGossipSigningPayload,
  encodePublishRequest,
  decodePublishRequest,
  encodePublishAck,
  decodePublishAck,
  encodeFinalizationMessage,
  decodeFinalizationMessage,
  encodeSharePublishRequest,
  decodeSharePublishRequest,
  type VerifyProposalMsg,
  type VerifyApprovalMsg,
  type StorageACKMsg,
  type GossipEnvelopeMsg,
} from '../src/index.js';

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

describe('V10 proto e2e: VERIFY flow simulation', () => {
  it('full verify: proposal → "send" → decode → approval → "send back" → decode', () => {
    // Proposer builds and sends a proposal
    const proposalId = randomBytes(16);
    const merkleRoot = randomBytes(32);
    const proposal: VerifyProposalMsg = {
      proposalId,
      verifiedMemoryId: 7,
      batchId: 42,
      merkleRoot,
      entities: ['http://example.org/alice', 'http://example.org/bob'],
      agentSignatureR: randomBytes(32),
      agentSignatureVS: randomBytes(32),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      contextGraphId: 'cg-42',
    };

    const proposalBytes = encodeVerifyProposal(proposal);

    // "Network transport" — decode on receiver side
    const receivedProposal = decodeVerifyProposal(proposalBytes);
    expect(new Uint8Array(receivedProposal.proposalId)).toEqual(proposalId);
    expect(new Uint8Array(receivedProposal.merkleRoot)).toEqual(merkleRoot);
    expect(receivedProposal.entities).toEqual(proposal.entities);

    // Approver signs and sends approval
    const approval: VerifyApprovalMsg = {
      proposalId: receivedProposal.proposalId,
      agentSignatureR: randomBytes(32),
      agentSignatureVS: randomBytes(32),
      approverAddress: '0xApprover1',
    };

    const approvalBytes = encodeVerifyApproval(approval);

    // "Network transport" — decode on proposer side
    const receivedApproval = decodeVerifyApproval(approvalBytes);
    expect(new Uint8Array(receivedApproval.proposalId)).toEqual(proposalId);
    expect(receivedApproval.approverAddress).toBe('0xApprover1');
  });

  it('multi-approval: collect M-of-N approvals', () => {
    const proposalId = randomBytes(16);
    const approvers = ['0xNode1', '0xNode2', '0xNode3'];
    const approvals: VerifyApprovalMsg[] = [];

    for (const addr of approvers) {
      const approval: VerifyApprovalMsg = {
        proposalId,
        agentSignatureR: randomBytes(32),
        agentSignatureVS: randomBytes(32),
        approverAddress: addr,
      };
      const bytes = encodeVerifyApproval(approval);
      const decoded = decodeVerifyApproval(bytes);
      approvals.push(decoded);
    }

    expect(approvals).toHaveLength(3);
    const addresses = approvals.map(a => a.approverAddress);
    expect(addresses).toEqual(approvers);

    // All approvals reference the same proposal
    for (const a of approvals) {
      expect(new Uint8Array(a.proposalId)).toEqual(proposalId);
    }
  });
});

describe('V10 proto e2e: PUBLISH flow with StorageACK', () => {
  it('publish request → storage ACK → finalization', () => {
    // Step 1: Encode publish request
    const contextGraphId = 'cg-42';
    const publishReq = encodePublishRequest({
      ual: 'did:dkg:mock:31337/0xAbc/1',
      nquads: new TextEncoder().encode('<s> <p> <o> .'),
      paranetId: contextGraphId,
      kas: [{ tokenId: 1, rootEntity: 'http://example.org/alice', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: randomBytes(32),
      publisherAddress: '0xPublisher',
      startKAId: 1,
      endKAId: 1,
      chainId: '31337',
      publisherSignatureR: randomBytes(32),
      publisherSignatureVs: randomBytes(32),
    });

    const decoded = decodePublishRequest(publishReq);
    expect(decoded.paranetId).toBe(contextGraphId);

    // Step 2: Core node sends StorageACK
    const ack: StorageACKMsg = {
      merkleRoot: randomBytes(32),
      coreNodeSignatureR: randomBytes(32),
      coreNodeSignatureVS: randomBytes(32),
      contextGraphId: 'cg-42',
      nodeIdentityId: 5,
    };
    const ackBytes = encodeStorageACK(ack);
    const decodedAck = decodeStorageACK(ackBytes);
    expect(new Uint8Array(decodedAck.merkleRoot)).toEqual(ack.merkleRoot);
    expect(decodedAck.contextGraphId).toBe('cg-42');

    // Step 3: Publisher sends finalization
    const finBytes = encodeFinalizationMessage({
      ual: 'did:dkg:mock:31337/0xAbc/1',
      paranetId: contextGraphId,
      kcMerkleRoot: ack.merkleRoot,
      txHash: '0xfeed',
      blockNumber: 12345,
      batchId: 1,
      startKAId: 1,
      endKAId: 1,
      publisherAddress: '0xPublisher',
      rootEntities: ['http://example.org/alice'],
      timestampMs: Date.now(),
    });
    const decodedFin = decodeFinalizationMessage(finBytes);
    expect(decodedFin.ual).toBe('did:dkg:mock:31337/0xAbc/1');
    expect(decodedFin.rootEntities).toEqual(['http://example.org/alice']);
  });
});

describe('V10 proto e2e: GossipSub envelope wrapping', () => {
  it('wrap shared-memory (SWM) share write in envelope → encode → decode → extract payload', () => {
    // Step 1: Create inner SharePublishRequest (shared memory write)
    const swmCgId = 'cg-42';
    const innerMsg = encodeSharePublishRequest({
      nquads: new TextEncoder().encode('<s> <p> <o> .'),
      paranetId: swmCgId,
      manifest: [{
        rootEntity: 'http://example.org/alice',
      }],
      publisherPeerId: '12D3KooW...',
      workspaceOperationId: 'op-1',
      timestampMs: Date.now(),
    });

    // Step 2: Wrap in V10 envelope
    const sigPayload = computeGossipSigningPayload(
      'share-write',
      swmCgId,
      '2026-04-02T12:00:00Z',
      innerMsg,
    );
    expect(sigPayload.length).toBeGreaterThan(innerMsg.length);

    const envelope: GossipEnvelopeMsg = {
      version: '10.0.0',
      type: 'share-write',
      contextGraphId: swmCgId,
      agentAddress: '0xAgent1',
      timestamp: '2026-04-02T12:00:00Z',
      signature: randomBytes(65),
      payload: innerMsg,
    };

    // Step 3: Encode envelope
    const envelopeBytes = encodeGossipEnvelope(envelope);

    // Step 4: Decode on receiver side
    const decoded = decodeGossipEnvelope(envelopeBytes);
    expect(decoded.version).toBe('10.0.0');
    expect(decoded.type).toBe('share-write');
    expect(decoded.contextGraphId).toBe(swmCgId);

    // Step 5: Extract and decode inner payload
    const innerDecoded = decodeSharePublishRequest(new Uint8Array(decoded.payload));
    expect(innerDecoded.paranetId).toBe(swmCgId);
    expect(innerDecoded.manifest).toHaveLength(1);
    expect(innerDecoded.manifest[0].rootEntity).toBe('http://example.org/alice');
  });

  it('envelope with publish ACK payload', () => {
    const ackPayload = encodePublishAck({
      merkleRoot: randomBytes(32),
      identityId: 5,
      signatureR: randomBytes(32),
      signatureVs: randomBytes(32),
      accepted: true,
      rejectionReason: '',
      publicByteSize: 1024,
    });

    const envelope: GossipEnvelopeMsg = {
      version: '10.0.0',
      type: 'publish-ack',
      contextGraphId: 'cg-42',
      agentAddress: '0xCoreNode',
      timestamp: new Date().toISOString(),
      signature: randomBytes(65),
      payload: ackPayload,
    };

    const decoded = decodeGossipEnvelope(encodeGossipEnvelope(envelope));
    const innerAck = decodePublishAck(new Uint8Array(decoded.payload));
    expect(innerAck.accepted).toBe(true);
  });

  it('envelope version must be 10.0.0 for V10 messages', () => {
    const envelope: GossipEnvelopeMsg = {
      version: '10.0.0',
      type: 'test',
      contextGraphId: 'cg-1',
      agentAddress: '0x...',
      timestamp: new Date().toISOString(),
      signature: new Uint8Array(0),
      payload: new Uint8Array(0),
    };

    const decoded = decodeGossipEnvelope(encodeGossipEnvelope(envelope));
    expect(decoded.version).toBe('10.0.0');
  });
});

describe('V10 proto e2e: cross-message interop', () => {
  it('StorageACK merkle root matches proposal merkle root', () => {
    const merkleRoot = randomBytes(32);

    const proposal: VerifyProposalMsg = {
      proposalId: randomBytes(16),
      verifiedMemoryId: 1,
      batchId: 1,
      merkleRoot,
      entities: ['http://example.org/e'],
      agentSignatureR: randomBytes(32),
      agentSignatureVS: randomBytes(32),
      expiresAt: new Date().toISOString(),
      contextGraphId: 'cg-1',
    };

    const ack: StorageACKMsg = {
      merkleRoot,
      coreNodeSignatureR: randomBytes(32),
      coreNodeSignatureVS: randomBytes(32),
      contextGraphId: 'cg-1',
      nodeIdentityId: 1,
    };

    const decodedProposal = decodeVerifyProposal(encodeVerifyProposal(proposal));
    const decodedAck = decodeStorageACK(encodeStorageACK(ack));

    expect(new Uint8Array(decodedProposal.merkleRoot)).toEqual(new Uint8Array(decodedAck.merkleRoot));
  });
});
