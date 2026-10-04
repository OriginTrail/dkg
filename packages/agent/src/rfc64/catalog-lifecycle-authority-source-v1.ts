// SPDX-License-Identifier: Apache-2.0

import type { ApprovedPrivateReplicaLifecycleProof, ApprovedPrivateReplicaLifecycleProofResolution } from '../approved-private-replica.js';
import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import type { Rfc64ParsedAuthoritySnapshotV1, Rfc64ReleaseNativeAuthoritySnapshotV1 } from './release-native-catalog-authority-v1.js';

export interface Rfc64RegisteredLifecycleAuthorityEvidenceV1 {
  readonly expectedNameHash: string;
  readonly expectedOnChainId: bigint;
  readonly snapshot: Rfc64ParsedAuthoritySnapshotV1;
}

/** Source precedence is selected once; lifecycle composition validates its constraints. */
export type Rfc64CatalogLifecycleAuthoritySourceV1 =
  | Readonly<{ kind: 'local-first' }>
  | Readonly<{ kind: 'compatibility'; snapshot: AcceptedRfc64CatalogAccessSnapshotV1 }>
  | Readonly<{ kind: 'approved-private'; proof: ApprovedPrivateReplicaLifecycleProof }>
  | Readonly<{ kind: 'replica-seed'; snapshot: Rfc64ReleaseNativeAuthoritySnapshotV1 }>
  | Readonly<{ kind: 'registered'; evidence: Rfc64RegisteredLifecycleAuthorityEvidenceV1 }>;

export type Rfc64ApprovedPrivateLifecycleSourceResolutionV1 = ApprovedPrivateReplicaLifecycleProofResolution;

export type Rfc64CatalogLifecycleAuthoritySourceResolutionV1 =
  | Readonly<{ kind: 'available'; source: Rfc64CatalogLifecycleAuthoritySourceV1 }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'facts-moved' }>;

function available(source: Rfc64CatalogLifecycleAuthoritySourceV1): Rfc64CatalogLifecycleAuthoritySourceResolutionV1 {
  return Object.freeze({ kind: 'available', source: Object.freeze(source) });
}

export async function resolveRfc64CatalogLifecycleAuthoritySourceV1(ports: {
  readonly bound: boolean;
  readonly finalizedAbsence: boolean;
  readonly readRegistered: () => Promise<Rfc64RegisteredLifecycleAuthorityEvidenceV1 | null>;
  readonly isLocalFirst: () => Promise<boolean>;
  readonly readCompatibility: () => AcceptedRfc64CatalogAccessSnapshotV1 | null;
  readonly resolveApprovedPrivate: () => Promise<Rfc64ApprovedPrivateLifecycleSourceResolutionV1>;
  readonly loadReplicaSeed: () => Promise<Rfc64ReleaseNativeAuthoritySnapshotV1 | null>;
}): Promise<Rfc64CatalogLifecycleAuthoritySourceResolutionV1> {
  if (ports.bound) {
    const evidence = await ports.readRegistered();
    return evidence === null ? Object.freeze({ kind: 'absent' }) : available({ kind: 'registered', evidence });
  }
  if (await ports.isLocalFirst()) return available({ kind: 'local-first' });
  const compatibility = ports.readCompatibility();
  if (compatibility?.policy.accessPolicy === 1
    && compatibility.roster !== null
    && compatibility.policy.source.kind === 'owner-signed-unregistered') {
    return available({ kind: 'compatibility', snapshot: compatibility });
  }
  // A proof cannot substitute for registration discovery. Signed replica seeds
  // require finalized absence; approved private joins also support legacy absence.
  // Public metadata alone is never an authority source.
  if (!ports.finalizedAbsence) {
    const evidence = await ports.readRegistered();
    if (evidence !== null) return available({ kind: 'registered', evidence });
  }
  const approved = await ports.resolveApprovedPrivate();
  if (approved.kind === 'facts-moved') return approved;
  if (approved.kind === 'available') return approved.proof.isCurrent()
    ? available({ kind: 'approved-private', proof: approved.proof })
    : Object.freeze({ kind: 'facts-moved' });
  if (!ports.finalizedAbsence) return Object.freeze({ kind: 'absent' });
  const replica = await ports.loadReplicaSeed();
  return replica === null ? Object.freeze({ kind: 'absent' }) : available({ kind: 'replica-seed', snapshot: replica });
}
