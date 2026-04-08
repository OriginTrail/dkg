import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

/** Manifest entry for one root entity in a shared-memory write (no tokenId). */
export const ShareManifestEntrySchema = new Type('ShareManifestEntry')
  .add(new Field('rootEntity', 1, 'string'))
  .add(new Field('privateMerkleRoot', 2, 'bytes'))
  .add(new Field('privateTripleCount', 3, 'uint32'));

/** CAS condition carried in gossip so receiving peers enforce the same guard. */
export const ShareCASConditionSchema = new Type('ShareCASCondition')
  .add(new Field('subject', 1, 'string'))
  .add(new Field('predicate', 2, 'string'))
  .add(new Field('expectedValue', 3, 'string'))
  .add(new Field('expectAbsent', 4, 'bool'));

export const SharePublishRequestSchema = new Type('SharePublishRequest')
  .add(new Field('contextGraphId', 1, 'string'))
  .add(new Field('nquads', 2, 'bytes'))
  .add(new Field('manifest', 3, 'ShareManifestEntry', 'repeated'))
  .add(new Field('publisherPeerId', 4, 'string'))
  .add(new Field('shareOperationId', 5, 'string'))
  .add(new Field('timestampMs', 6, 'uint64'))
  .add(new Field('operationId', 7, 'string'))
  .add(new Field('casConditions', 8, 'ShareCASCondition', 'repeated'))
  .add(ShareManifestEntrySchema)
  .add(ShareCASConditionSchema);

export interface ShareManifestEntryMsg {
  rootEntity: string;
  privateMerkleRoot?: Uint8Array;
  privateTripleCount?: number;
}

export interface ShareCASConditionMsg {
  subject: string;
  predicate: string;
  /** Expected RDF term, or empty string when expectAbsent is true. */
  expectedValue: string;
  /** If true, the triple (subject, predicate, *) must not exist. */
  expectAbsent: boolean;
}

export interface SharePublishRequestMsg {
  contextGraphId: string;
  nquads: Uint8Array;
  manifest: ShareManifestEntryMsg[];
  publisherPeerId: string;
  shareOperationId: string;
  timestampMs: number | bigint;
  /** Originator's operation ID for cross-node log correlation. */
  operationId?: string;
  /** CAS conditions that receiving peers must enforce before applying this write. */
  casConditions?: ShareCASConditionMsg[];
}

export function encodeSharePublishRequest(msg: SharePublishRequestMsg): Uint8Array {
  const ts = typeof msg.timestampMs === 'bigint' ? Number(msg.timestampMs) : msg.timestampMs;
  return SharePublishRequestSchema.encode(
    SharePublishRequestSchema.create({ ...msg, timestampMs: ts }),
  ).finish();
}

export function decodeSharePublishRequest(buf: Uint8Array): SharePublishRequestMsg {
  const decoded = SharePublishRequestSchema.decode(buf) as unknown as SharePublishRequestMsg;
  const ts = decoded.timestampMs;
  return {
    ...decoded,
    timestampMs: typeof ts === 'bigint' ? Number(ts) : (ts as number),
  };
}
