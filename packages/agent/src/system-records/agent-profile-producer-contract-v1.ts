import {
  type AssertionCoordinateV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
} from '@origintrail-official/dkg-core';
import {
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
  type Digest32V1,
  type NetworkIdV1,
  type OwnedSubjectTableObjectV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
  type SystemRecordInventoryTreeSnapshotV1,
  type SystemRecordObjectKindV1,
  type SystemRecordPeerPublicKeyV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import type { Quad } from '@origintrail-official/dkg-storage';

import type { EvmPersonalMessageSignerV1 } from '../evm-message-signer-v1.js';
import type { PreparedAgentProfileV1 } from '../profile.js';
import type { SystemRecordArtifactV1 } from './artifact-v1.js';

export interface SystemRecordPeerSignerV1 {
  readonly peerId: string;
  readonly publicKey: SystemRecordPeerPublicKeyV1;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export type AgentProfilePublicationStatusV1 = 'tentative' | 'confirmed' | 'failed';

/** Untrusted legacy-publication result accepted at the producer boundary. */
export interface AgentProfilePublicationBindingV1 {
  readonly publicationStatus: AgentProfilePublicationStatusV1;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly seal: Readonly<CanonicalGraphScopedAuthorSealV1>;
  readonly issuedAt: string;
  readonly validUntil: string;
  readonly projectionSchemaDigest: Digest32V1;
}

export interface AgentProfileProducerInstallInputV1 {
  readonly head: AgentProfileActiveHeadObjectV1;
  readonly envelope: SignedAgentProfileHeadEnvelopeV1;
  readonly canonicalProjectionBytes: Uint8Array;
  readonly projectionQuads: readonly Readonly<Quad>[];
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
  readonly signal: AbortSignal;
}

export interface AgentProfileProducerPublicationV1 {
  readonly headDigest: Digest32V1;
  readonly rootDescriptorDigest: Digest32V1;
  readonly version: string;
  readonly authoritySequence: string;
  readonly inventoryWrites: number;
  readonly inventoryWriteBytes: number;
}

export interface AgentProfileProducerPublicationCommitV1 {
  /** Snapshot preconditions reserved before materialization begins. */
  readonly expectedHeadDigest: Digest32V1 | null;
  readonly expectedRootDescriptorDigest: Digest32V1 | null;
  readonly publicationArtifacts: AgentProfileProducerPublicationArtifactsV1;
  readonly inventory: SystemRecordInventoryTreeSnapshotV1;
  readonly rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1;
}

type AgentProfileProducerArtifactV1<Kind extends SystemRecordObjectKindV1> = Readonly<
  Omit<SystemRecordArtifactV1, 'objectKind'> & { objectKind: Kind }
>;

export interface AgentProfileProducerPublicationArtifactsV1 {
  readonly head: AgentProfileProducerArtifactV1<'agent-profile-head'>;
  readonly bundle: AgentProfileProducerArtifactV1<'profile-bundle'>;
  readonly ownedSubjectTable: AgentProfileProducerArtifactV1<'owned-subject-table'>;
  readonly inventoryObjects: readonly AgentProfileProducerArtifactV1<
    'inventory-internal' | 'inventory-leaf'
  >[];
}

export function flattenAgentProfileProducerPublicationArtifactsV1(
  artifacts: AgentProfileProducerPublicationArtifactsV1,
): readonly SystemRecordArtifactV1[] {
  return Object.freeze([
    artifacts.head,
    artifacts.bundle,
    artifacts.ownedSubjectTable,
    ...artifacts.inventoryObjects,
  ]);
}

export interface AgentProfileProducerPublicationCommitLeaseV1 {
  commit(): void | Promise<void>;
  abort(): void;
}

export interface AgentProfileProducerPublicationStoreV1 {
  snapshot(): Readonly<{
    inventory: SystemRecordInventoryTreeSnapshotV1 | null;
    currentHead: SignedAgentProfileHeadEnvelopeV1 | null;
  }>;
  /** Resolve retained authority history by content address, without wire semantics. */
  resolveArtifact(
    reference: Pick<SystemRecordArtifactV1, 'objectKind' | 'objectDigest'>,
  ): SystemRecordArtifactV1 | null | Promise<SystemRecordArtifactV1 | null>;
  /** Atomically verify and reserve the expected snapshot until commit or abort. */
  prepareCommit(
    input: AgentProfileProducerPublicationCommitV1,
  ): AgentProfileProducerPublicationCommitLeaseV1 | Promise<AgentProfileProducerPublicationCommitLeaseV1>;
}

export interface CreateAgentProfileProducerOptionsV1 {
  readonly networkId: NetworkIdV1;
  /** Locally pinned VM publication lane; never derived from an untrusted seal. */
  readonly publicationDeployment: Readonly<CatalogSealDeploymentProfileV1>;
  readonly peerSigner: SystemRecordPeerSignerV1;
  readonly evmSigner: EvmPersonalMessageSignerV1;
  readonly store: AgentProfileProducerPublicationStoreV1;
  /** Independent verifier clock; publication timestamps are untrusted input. */
  readonly nowMs?: () => number;
  /** Storage-runtime bridge: fence before publish; successful install commits advertisement. */
  readonly fence: (
    prepared: PreparedAgentProfileV1,
    signal: AbortSignal,
  ) => void | Promise<void>;
  readonly install: (input: AgentProfileProducerInstallInputV1) => void | Promise<void>;
}

export interface AgentProfileProducerLeaseV1 {
  complete(
    publication: AgentProfilePublicationBindingV1,
  ): Promise<AgentProfileProducerPublicationV1>;
  abort(reason?: unknown): void;
}

export interface AgentProfileProducerV1 {
  /** Fence one immutable profile before the legacy publication begins. */
  prepare(
    prepared: PreparedAgentProfileV1,
  ): Promise<AgentProfileProducerLeaseV1>;
}
