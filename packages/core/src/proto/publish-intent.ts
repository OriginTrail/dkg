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
 * PublishIntent message (spec §9.0, §15.1).
 *
 * Broadcast via GossipSub on the finalization topic to signal that a
 * publisher is about to submit a chain TX and needs 3 core node StorageACKs.
 *
 * Core nodes that have the data in SWM verify the merkle root and respond
 * with a StorageACK via direct P2P stream `/dkg/10.0.0/storage-ack`.
 */

export const PublishIntentSchema = new Type('PublishIntent')
  .add(new Field('merkleRoot', 1, 'bytes'))
  .add(new Field('contextGraphId', 2, 'string'))
  .add(new Field('publisherPeerId', 3, 'string'))
  .add(new Field('publicByteSize', 4, 'uint64'))
  .add(new Field('isPrivate', 5, 'bool'))
  .add(new Field('kaCount', 6, 'uint32'))
  .add(new Field('rootEntities', 7, 'string', 'repeated'))
  .add(new Field('stagingQuads', 8, 'bytes'))
  .add(new Field('epochs', 9, 'uint32'))
  .add(new Field('tokenAmountStr', 10, 'string'))
  // `contextGraphId` above is the TARGET on-chain numeric CG id used in the
  // ACK digest and the on-chain tx. The SWM data the peer must read lives
  // under a (possibly different) SOURCE graph — the `publishFromSharedMemory`
  // remap flow lets callers read from "devnet-test" and publish to numeric
  // id 42. Handlers resolve SWM via `swmGraphId ?? contextGraphId` + the
  // optional `subGraphName` suffix.
  .add(new Field('swmGraphId', 11, 'string'))
  .add(new Field('subGraphName', 12, 'string'));

type Long = { low: number; high: number; unsigned: boolean };

export interface PublishIntentMsg {
  merkleRoot: Uint8Array;
  /** Target on-chain numeric CG id used by the ACK digest and the publishDirect tx. */
  contextGraphId: string;
  publisherPeerId: string;
  publicByteSize: number | Long;
  isPrivate: boolean;
  kaCount: number;
  rootEntities: string[];
  stagingQuads?: Uint8Array;
  epochs?: number;
  /** Decimal string representation of tokenAmount for lossless bigint transport. */
  tokenAmountStr?: string;
  /**
   * Source SWM graph id used by the peer to locate the data to verify. If
   * absent, peers fall back to `contextGraphId`. Different from
   * `contextGraphId` only when the publisher called
   * `publishFromSharedMemory` with an explicit `publishContextGraphId`
   * remap (source graph "foo" → on-chain id 42).
   */
  swmGraphId?: string;
  /**
   * Optional sub-graph name appended to the SWM URI. Lets core peers load
   * `.../<swmGraphId>/<subGraphName>/_shared_memory` when the publisher
   * writes into a sub-graph partition.
   */
  subGraphName?: string;
}

export function encodePublishIntent(msg: PublishIntentMsg): Uint8Array {
  return PublishIntentSchema.encode(
    PublishIntentSchema.create(msg),
  ).finish();
}

export function decodePublishIntent(buf: Uint8Array): PublishIntentMsg {
  return PublishIntentSchema.decode(buf) as unknown as PublishIntentMsg;
}
