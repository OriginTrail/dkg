import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

/** Manifest entry for one root entity in a workspace write (no tokenId). */
export const WorkspaceManifestEntrySchema = new Type('WorkspaceManifestEntry')
  .add(new Field('rootEntity', 1, 'string'))
  .add(new Field('privateMerkleRoot', 2, 'bytes'))
  .add(new Field('privateTripleCount', 3, 'uint32'));

export const WorkspacePublishRequestSchema = new Type('WorkspacePublishRequest')
  .add(new Field('paranetId', 1, 'string'))
  .add(new Field('nquads', 2, 'bytes'))
  .add(new Field('manifest', 3, 'WorkspaceManifestEntry', 'repeated'))
  .add(new Field('publisherPeerId', 4, 'string'))
  .add(new Field('workspaceOperationId', 5, 'string'))
  .add(new Field('timestampMs', 6, 'uint64'))
  .add(new Field('operationId', 7, 'string'))
  .add(WorkspaceManifestEntrySchema);

export interface WorkspaceManifestEntryMsg {
  rootEntity: string;
  privateMerkleRoot?: Uint8Array;
  privateTripleCount?: number;
}

export interface WorkspacePublishRequestMsg {
  paranetId: string;
  nquads: Uint8Array;
  manifest: WorkspaceManifestEntryMsg[];
  publisherPeerId: string;
  workspaceOperationId: string;
  timestampMs: number | bigint;
  /** Originator's operation ID for cross-node log correlation. */
  operationId?: string;
}

export function encodeWorkspacePublishRequest(msg: WorkspacePublishRequestMsg): Uint8Array {
  const ts = typeof msg.timestampMs === 'bigint' ? Number(msg.timestampMs) : msg.timestampMs;
  return WorkspacePublishRequestSchema.encode(
    WorkspacePublishRequestSchema.create({ ...msg, timestampMs: ts }),
  ).finish();
}

export function decodeWorkspacePublishRequest(buf: Uint8Array): WorkspacePublishRequestMsg {
  const decoded = WorkspacePublishRequestSchema.decode(buf) as unknown as WorkspacePublishRequestMsg;
  const ts = decoded.timestampMs;
  return {
    ...decoded,
    timestampMs: typeof ts === 'bigint' ? Number(ts) : (ts as number),
  };
}
