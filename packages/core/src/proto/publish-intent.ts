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
  .add(new Field('stagingQuads', 8, 'bytes'));

type Long = { low: number; high: number; unsigned: boolean };

export interface PublishIntentMsg {
  merkleRoot: Uint8Array;
  contextGraphId: string;
  publisherPeerId: string;
  publicByteSize: number | Long;
  isPrivate: boolean;
  kaCount: number;
  rootEntities: string[];
  stagingQuads?: Uint8Array;
}

export function encodePublishIntent(msg: PublishIntentMsg): Uint8Array {
  return PublishIntentSchema.encode(
    PublishIntentSchema.create(msg),
  ).finish();
}

export function decodePublishIntent(buf: Uint8Array): PublishIntentMsg {
  return PublishIntentSchema.decode(buf) as unknown as PublishIntentMsg;
}
