import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

/**
 * VERIFY protocol messages (spec §15.2).
 *
 * Used for M-of-N verification of LTM → VM transitions.
 * Sent via direct P2P streams, not GossipSub.
 */

const VerifyProposalSchema = new Type('VerifyProposal')
  .add(new Field('proposalId', 1, 'bytes'))
  .add(new Field('verifiedMemoryId', 2, 'uint64'))
  .add(new Field('batchId', 3, 'uint64'))
  .add(new Field('merkleRoot', 4, 'bytes'))
  .add(new Field('entities', 5, 'string', 'repeated'))
  .add(new Field('agentSignatureR', 6, 'bytes'))
  .add(new Field('agentSignatureVS', 7, 'bytes'))
  .add(new Field('expiresAt', 8, 'string'))
  .add(new Field('contextGraphId', 9, 'string'));

const VerifyApprovalSchema = new Type('VerifyApproval')
  .add(new Field('proposalId', 1, 'bytes'))
  .add(new Field('agentSignatureR', 2, 'bytes'))
  .add(new Field('agentSignatureVS', 3, 'bytes'))
  .add(new Field('approverAddress', 4, 'string'));

type Long = { low: number; high: number; unsigned: boolean };

export interface VerifyProposalMsg {
  proposalId: Uint8Array;
  verifiedMemoryId: number | Long;
  batchId: number | Long;
  merkleRoot: Uint8Array;
  entities: string[];
  agentSignatureR: Uint8Array;
  agentSignatureVS: Uint8Array;
  expiresAt: string;
  contextGraphId: string;
}

export interface VerifyApprovalMsg {
  proposalId: Uint8Array;
  agentSignatureR: Uint8Array;
  agentSignatureVS: Uint8Array;
  approverAddress: string;
}

export function encodeVerifyProposal(msg: VerifyProposalMsg): Uint8Array {
  return VerifyProposalSchema.encode(
    VerifyProposalSchema.create(msg),
  ).finish();
}

export function decodeVerifyProposal(buf: Uint8Array): VerifyProposalMsg {
  return VerifyProposalSchema.decode(buf) as unknown as VerifyProposalMsg;
}

export function encodeVerifyApproval(msg: VerifyApprovalMsg): Uint8Array {
  return VerifyApprovalSchema.encode(
    VerifyApprovalSchema.create(msg),
  ).finish();
}

export function decodeVerifyApproval(buf: Uint8Array): VerifyApprovalMsg {
  return VerifyApprovalSchema.decode(buf) as unknown as VerifyApprovalMsg;
}
