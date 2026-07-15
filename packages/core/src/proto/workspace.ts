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

/** Manifest entry for one root entity in a shared memory write (no tokenId). */
export const WorkspaceManifestEntrySchema = new Type('WorkspaceManifestEntry')
  .add(new Field('rootEntity', 1, 'string'))
  .add(new Field('privateMerkleRoot', 2, 'bytes'))
  .add(new Field('privateTripleCount', 3, 'uint32'));

/** CAS condition carried in gossip so receiving peers enforce the same guard. */
export const WorkspaceCASConditionSchema = new Type('WorkspaceCASCondition')
  .add(new Field('subject', 1, 'string'))
  .add(new Field('predicate', 2, 'string'))
  .add(new Field('expectedValue', 3, 'string'))
  .add(new Field('expectAbsent', 4, 'bool'));

export const WorkspacePublishRequestSchema = new Type('WorkspacePublishRequest')
  .add(new Field('contextGraphId', 1, 'string'))
  .add(new Field('nquads', 2, 'bytes'))
  .add(new Field('manifest', 3, 'WorkspaceManifestEntry', 'repeated'))
  .add(new Field('publisherPeerId', 4, 'string'))
  .add(new Field('shareOperationId', 5, 'string'))
  .add(new Field('timestampMs', 6, 'uint64'))
  .add(new Field('operationId', 7, 'string'))
  .add(new Field('casConditions', 8, 'WorkspaceCASCondition', 'repeated'))
  .add(new Field('subGraphName', 9, 'string'))
  // OT-RFC-46 — per-KA SWM identity: receivers/sync target …/_shared_memory/{addr}/{number}
  .add(new Field('agentAddress', 10, 'string'))
  .add(new Field('kaNumber', 11, 'string'))
  // Rootless KA scope. Messages on the graph-scope protocol MUST set version
  // 2 and leave the legacy per-root manifest empty.
  .add(new Field('contentScopeVersion', 12, 'uint32'))
  .add(new Field('kaUal', 13, 'string'))
  .add(new Field('assertionVersion', 14, 'string'))
  .add(new Field('publicTripleCount', 15, 'uint32'))
  .add(new Field('privateMerkleRoot', 16, 'bytes'))
  .add(new Field('privateTripleCount', 17, 'uint32'))
  .add(WorkspaceManifestEntrySchema)
  .add(WorkspaceCASConditionSchema);

export interface WorkspaceManifestEntryMsg {
  rootEntity: string;
  privateMerkleRoot?: Uint8Array;
  privateTripleCount?: number;
}

export interface WorkspaceCASConditionMsg {
  subject: string;
  predicate: string;
  /** Expected RDF term, or empty string when expectAbsent is true. */
  expectedValue: string;
  /** If true, the triple (subject, predicate, *) must not exist. */
  expectAbsent: boolean;
}

export interface WorkspacePublishRequestMsg {
  contextGraphId: string;
  nquads: Uint8Array;
  manifest: WorkspaceManifestEntryMsg[];
  publisherPeerId: string;
  shareOperationId: string;
  timestampMs: number | bigint;
  /** Originator's operation ID for cross-node log correlation. */
  operationId?: string;
  /** CAS conditions that receiving peers must enforce before applying this write. */
  casConditions?: WorkspaceCASConditionMsg[];
  /** Sub-graph within the context graph. Receivers store in sub-graph SWM if set. */
  subGraphName?: string;
  /** OT-RFC-46 — the KA's author address; receivers target the per-KA SWM graph. */
  agentAddress?: string;
  /** OT-RFC-46 — the KA number (bigint as string); the per-KA SWM graph key. */
  kaNumber?: string;
  /** Rootless KA graph-scope discriminator. New writers emit exactly 2. */
  contentScopeVersion?: number;
  /** Canonical deterministic UAL; authoritative over agentAddress/kaNumber. */
  kaUal?: string;
  /** One-based assertion/Merkle-root index encoded as a decimal string. */
  assertionVersion?: string;
  /** Number of public RDF triples in this complete KA assertion. */
  publicTripleCount?: number;
  /** Optional single KA-level private commitment (never private plaintext). */
  privateMerkleRoot?: Uint8Array;
  /** Number of private RDF triples committed by privateMerkleRoot. */
  privateTripleCount?: number;
}

export function encodeWorkspacePublishRequest(msg: WorkspacePublishRequestMsg): Uint8Array {
  if (!String(msg.shareOperationId ?? '').trim()) {
    throw new Error('WorkspacePublishRequest requires shareOperationId');
  }
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

// ── V10 aliases (Workspace → SharedMemory / Share) ──────────────────────
export type ShareManifestEntryMsg = WorkspaceManifestEntryMsg;
export type ShareCASConditionMsg = WorkspaceCASConditionMsg;
export type SharePublishRequestMsg = WorkspacePublishRequestMsg;
export const encodeSharePublishRequest = encodeWorkspacePublishRequest;
export const decodeSharePublishRequest = decodeWorkspacePublishRequest;
