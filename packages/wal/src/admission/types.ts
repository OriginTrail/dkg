import type { AdmissionRecord, WalObjectMetadataRecord } from '../control/types.js';
import type { WalObjectV1, VerifiedWalObjectV1 } from '../protocol/wal-object.js';
import type { WalObjectId } from '../reconciliation/ids.js';

export type WalAdmissionIngress = 'local' | 'network' | 'backfill' | 'replay';
export type WalAdmissionVisibility = 'public' | 'private';
export type WalAdmissionDependencyRole =
  | 'parent'
  | 'base-head'
  | 'policy'
  | 'content'
  | 'vm-evidence';

export type WalAdmissionEvidenceDecision = 'accepted' | 'missing' | 'invalid';
export type WalAdmissionDeferredDecision = 'accepted' | 'pending' | 'invalid';

export interface WalAdmissionCandidate {
  readonly objectId: Uint8Array;
  readonly canonicalBytes: Uint8Array;
  readonly providerPeerId: Uint8Array;
  readonly ingress: WalAdmissionIngress;
  readonly visibility: WalAdmissionVisibility;
  readonly checkpointProofBytes?: Uint8Array | null;
  readonly closureProofBytes?: Uint8Array | null;
  readonly storageOrigin?: 'REMOTE' | 'GENESIS' | 'SNAPSHOT';
}

export interface WalAdmissionPayloadInspection {
  /** True only when opening content requires current private membership. */
  readonly privatePayload: boolean;
  /** Adapter-owned immutable parse result; generic admission never interprets it. */
  readonly descriptor: unknown;
}

export interface WalAdmissionPayloadAnalysis {
  readonly adapterVersion: number;
  readonly logicalKeys: readonly Uint8Array[];
  readonly parents: readonly Uint8Array[];
  readonly baseHeads: readonly Uint8Array[];
  readonly policyObjectId: Uint8Array | null;
  readonly contentObjectIds?: readonly Uint8Array[];
  readonly vmEvidenceObjectIds?: readonly Uint8Array[];
  readonly carriesChainEvidence?: boolean;
  readonly carriesVmEvidence?: boolean;
}

export interface WalAdmissionVerifiedObject {
  readonly candidate: WalAdmissionCandidate;
  readonly verified: VerifiedWalObjectV1;
  readonly inspection: WalAdmissionPayloadInspection;
  readonly analysis: WalAdmissionPayloadAnalysis;
}

export interface WalAdmissionDependencyRequest {
  readonly objectId: WalObjectId;
  readonly role: WalAdmissionDependencyRole;
  readonly requestedByObjectId: WalObjectId;
  readonly depth: number;
}

export interface WalAdmissionAdapter {
  /** Parse only the adapter envelope header; do not decrypt or inspect private content. */
  inspectPayload(input: {
    objectId: WalObjectId;
    object: WalObjectV1;
    payloadBytes: Uint8Array;
    visibility: WalAdmissionVisibility;
  }): WalAdmissionPayloadInspection | Promise<WalAdmissionPayloadInspection>;

  /** Current DKG membership/delegation check; always runs before private open. */
  authorizePrivate(input: {
    candidate: WalAdmissionCandidate;
    objectId: WalObjectId;
    object: WalObjectV1;
    inspection: WalAdmissionPayloadInspection;
  }): boolean | Promise<boolean>;

  /** Open/decode the adapter payload and return only generic closure coordinates. */
  openPayload(input: {
    candidate: WalAdmissionCandidate;
    objectId: WalObjectId;
    object: WalObjectV1;
    inspection: WalAdmissionPayloadInspection;
  }): WalAdmissionPayloadAnalysis | Promise<WalAdmissionPayloadAnalysis>;

  verifyCheckpointInclusion(input: {
    candidate: WalAdmissionCandidate;
    objectId: WalObjectId;
    object: WalObjectV1;
  }): WalAdmissionEvidenceDecision | Promise<WalAdmissionEvidenceDecision>;

  authorizeNamespace(input: {
    candidate: WalAdmissionCandidate;
    objectId: WalObjectId;
    object: WalObjectV1;
  }): boolean | Promise<boolean>;

  validatePolicy(input: {
    object: WalAdmissionVerifiedObject;
    closure: ReadonlyMap<string, WalAdmissionVerifiedObject>;
    admittedPolicy: WalObjectMetadataRecord | null;
  }): WalAdmissionEvidenceDecision | Promise<WalAdmissionEvidenceDecision>;

  validateCrossAuthorReferences(input: {
    object: WalAdmissionVerifiedObject;
    closure: ReadonlyMap<string, WalAdmissionVerifiedObject>;
  }): boolean | Promise<boolean>;

  validateReferenceScopes(input: {
    object: WalAdmissionVerifiedObject;
    closure: ReadonlyMap<string, WalAdmissionVerifiedObject>;
  }): 'accepted' | 'cross-view' | 'invalid' | Promise<'accepted' | 'cross-view' | 'invalid'>;

  validateChainEvidence(input: {
    object: WalAdmissionVerifiedObject;
    closure: ReadonlyMap<string, WalAdmissionVerifiedObject>;
  }): WalAdmissionDeferredDecision | Promise<WalAdmissionDeferredDecision>;

  validateVmEvidence(input: {
    object: WalAdmissionVerifiedObject;
    closure: ReadonlyMap<string, WalAdmissionVerifiedObject>;
  }): WalAdmissionDeferredDecision | Promise<WalAdmissionDeferredDecision>;
}

export interface WalAdmissionStateStore {
  getAdmission(objectId: Uint8Array): AdmissionRecord | null;
  stageAdmission(input: {
    objectId: Uint8Array;
    providerPeerId?: Uint8Array | null;
    proofBytes?: Uint8Array | null;
    closureBytes?: Uint8Array | null;
    updatedAtMs?: number;
  }): void;
  setAdmissionState(
    objectId: Uint8Array,
    state: 'BLOCKED' | 'QUARANTINED',
    reasonCode: string,
    updatedAtMs?: number,
  ): void;
  getWalObjectMetadata(objectId: Uint8Array): WalObjectMetadataRecord | null;
  findWalObjectAtPosition(
    namespaceId: Uint8Array,
    writerId: Uint8Array,
    writerEpoch: bigint,
    sequence: bigint,
  ): WalObjectMetadataRecord | null;
  admitRemoteBatch(inputs: readonly {
    objectId: Uint8Array;
    object: WalObjectV1;
    canonicalLength: number;
    origin?: 'REMOTE' | 'GENESIS' | 'SNAPSHOT';
    logicalKeys?: readonly Uint8Array[];
  }[], updatedAtMs?: number): Promise<void>;
  quarantine(input: {
    entryId: Uint8Array;
    providerPeerId: Uint8Array;
    reasonCode: string;
    relativePath?: string | null;
    byteLength: number;
    createdAtMs?: number;
    expiresAtMs?: number;
  }): void;
  quarantineAdmission(input: {
    entryId: Uint8Array;
    providerPeerId: Uint8Array;
    reasonCode: string;
    relativePath?: string | null;
    byteLength: number;
    createdAtMs?: number;
    expiresAtMs?: number;
    admissionObjectId?: Uint8Array;
    blockedRootObjectId?: Uint8Array | null;
    updatedAtMs?: number;
  }): Promise<void>;
}

export interface WalAdmissionObjectStore {
  has(id: WalObjectId): Promise<boolean>;
  put(expectedId: WalObjectId, bytes: AsyncIterable<Uint8Array>): Promise<void>;
}

export interface WalAdmissionOptions {
  readonly adapter: WalAdmissionAdapter;
  readonly state: WalAdmissionStateStore;
  readonly objects: WalAdmissionObjectStore;
  readonly fetchDependency: (
    request: WalAdmissionDependencyRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<WalAdmissionCandidate | null>;
  readonly supportedAdapterVersions: readonly number[];
  readonly maximumObjectBytes?: number;
  readonly maximumClosureObjects?: number;
  readonly maximumClosureBytes?: number;
  readonly maximumClosureDepth?: number;
  readonly maximumReferencesPerObject?: number;
  readonly maximumLogicalKeysPerObject?: number;
  readonly now?: () => number;
}

export interface WalAdmissionValidation {
  readonly status: 'valid' | 'blocked' | 'quarantined';
  readonly reasonCode: WalAdmissionReasonCode | null;
  readonly rootObjectId: WalObjectId;
  readonly relatedObjectId?: WalObjectId;
  readonly missingObjectIds: readonly WalObjectId[];
  readonly objects: readonly WalAdmissionVerifiedObject[];
}

export type WalAdmissionResult = Omit<WalAdmissionValidation, 'status'> & {
  readonly status: 'admitted' | 'already-admitted' | 'blocked' | 'quarantined';
};

export type WalAdmissionReasonCode =
  | 'INVALID_WAL_OBJECT'
  | 'WAL_OBJECT_ID_MISMATCH'
  | 'INVALID_LANE_LINK'
  | 'PRIVATE_UNAUTHORIZED'
  | 'PAYLOAD_ENVELOPE_INVALID'
  | 'PRIVATE_PAYLOAD_INVALID'
  | 'CHECKPOINT_UNAVAILABLE'
  | 'CHECKPOINT_INVALID'
  | 'NAMESPACE_UNAUTHORIZED'
  | 'PAYLOAD_INVALID'
  | 'ADAPTER_VERSION_UNSUPPORTED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'DEPENDENCY_INVALID'
  | 'CLOSURE_DEPTH_EXCEEDED'
  | 'CLOSURE_OBJECT_LIMIT_EXCEEDED'
  | 'CLOSURE_BYTE_LIMIT_EXCEEDED'
  | 'REFERENCE_LIMIT_EXCEEDED'
  | 'LOGICAL_KEY_LIMIT_EXCEEDED'
  | 'CAUSAL_CYCLE'
  | 'CROSS_VIEW_REFERENCE'
  | 'CAUSAL_LINK_INVALID'
  | 'POLICY_UNAVAILABLE'
  | 'POLICY_INVALID'
  | 'CROSS_AUTHOR_UNAUTHORIZED'
  | 'CHAIN_EVIDENCE_PENDING'
  | 'CHAIN_EVIDENCE_INVALID'
  | 'VM_EVIDENCE_PENDING'
  | 'VM_EVIDENCE_INVALID'
  | 'AUTHOR_EQUIVOCATION'
  | 'QUARANTINE_LIMIT_EXCEEDED'
  | 'PERSISTENCE_FAILED';

export interface WalAdmissionInternalObject {
  candidate: WalAdmissionCandidate;
  verified: VerifiedWalObjectV1;
  objectId: WalObjectId;
  inspection: WalAdmissionPayloadInspection;
  analysis: WalAdmissionPayloadAnalysis;
  depth: number;
  references: Array<{ id: WalObjectId; role: WalAdmissionDependencyRole }>;
}
