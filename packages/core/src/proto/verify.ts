/**
 * Protobuf wire schemas used by this module for encode/decode helpers.
 *
 * The `*Schema` consts below are exported strictly for backwards
 * compatibility with external consumers that deep-imported them
 * before `@origintrail-official/dkg-core` had an `exports` map.
 * They are implementation detail — prefer the `*Msg` types and
 * `encode*` / `decode*` functions re-exported from
 * `packages/core/src/proto/index.ts`.
 *
 * @internal
 */
import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

/**
 * VERIFY protocol messages (spec §15.2).
 *
 * Used for M-of-N verification of LTM → VM transitions.
 * Sent via direct P2P streams, not GossipSub.
 */

export const VerifyProposalSchema = new Type('VerifyProposal')
  .add(new Field('proposalId', 1, 'bytes'))
  .add(new Field('verifiableMemoryId', 2, 'uint64'))
  .add(new Field('batchId', 3, 'string'))
  .add(new Field('merkleRoot', 4, 'bytes'))
  .add(new Field('entities', 5, 'string', 'repeated'))
  .add(new Field('agentSignatureR', 6, 'bytes'))
  .add(new Field('agentSignatureVS', 7, 'bytes'))
  .add(new Field('expiresAt', 8, 'string'))
  .add(new Field('contextGraphId', 9, 'string'));

export const VerifyApprovalSchema = new Type('VerifyApproval')
  .add(new Field('proposalId', 1, 'bytes'))
  .add(new Field('agentSignatureR', 2, 'bytes'))
  .add(new Field('agentSignatureVS', 3, 'bytes'))
  .add(new Field('approverAddress', 4, 'string'));

type Long = { low: number; high: number; unsigned: boolean };

export interface VerifyProposalMsg {
  proposalId: Uint8Array;
  verifiableMemoryId: number | Long;
  batchId: string | number | bigint | Long;
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

/**
 * Convert a KA id (batchId) into the decimal-string wire shape. KA ids are
 * packed Option-1 values `(uint160(author) << 96) | number` (~256-bit), which
 * do NOT fit a uint64 gossip field. Per OT-RFC-43 §9 the id wire type is a
 * decimal string, so we accept string / number / bigint / protobuf Long and
 * emit the canonical decimal string losslessly.
 */
function idToProtoString(val: string | number | bigint | Long): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'bigint') return val.toString();
  if (typeof val === 'number') return val.toString();
  const lo = BigInt(val.low >>> 0); const hi = BigInt(val.high >>> 0);
  return ((hi << 32n) | lo).toString();
}

export function encodeVerifyProposal(msg: VerifyProposalMsg): Uint8Array {
  return VerifyProposalSchema.encode(
    VerifyProposalSchema.create({
      ...msg,
      batchId: idToProtoString(msg.batchId),
    }),
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
