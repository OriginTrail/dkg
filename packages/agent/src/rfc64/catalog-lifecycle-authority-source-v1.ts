import type { ApprovedPrivateReplicaAuthority } from '../approved-private-replica.js';
import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import type { Rfc64ReleaseNativeAuthoritySnapshotV1 } from './release-native-catalog-authority-v1.js';

/** Source precedence is selected once; lifecycle composition validates its constraints. */
export type Rfc64CatalogLifecycleAuthoritySourceV1 =
  | Readonly<{ kind: 'local-first' }>
  | Readonly<{ kind: 'compatibility'; snapshot: AcceptedRfc64CatalogAccessSnapshotV1 }>
  | Readonly<{ kind: 'approved-private'; authority: ApprovedPrivateReplicaAuthority; metadataRevision: string; requesterRevision: number }>
  | Readonly<{ kind: 'replica-seed'; snapshot: Rfc64ReleaseNativeAuthoritySnapshotV1 }>
  | Readonly<{ kind: 'registered' }>;

export async function resolveRfc64CatalogLifecycleAuthoritySourceV1(ports: {
  readonly bound: boolean;
  readonly finalizedAbsence: boolean;
  readonly isLocalFirst: () => Promise<boolean>;
  readonly readCompatibility: () => AcceptedRfc64CatalogAccessSnapshotV1 | null;
  readonly resolveApprovedPrivate: () => Promise<Readonly<{
    authority: ApprovedPrivateReplicaAuthority;
    metadataRevision: string; requesterRevision: number;
  }> | null>;
  readonly loadReplicaSeed: () => Promise<Rfc64ReleaseNativeAuthoritySnapshotV1 | null>;
}): Promise<Rfc64CatalogLifecycleAuthoritySourceV1 | null> {
  if (ports.bound) return Object.freeze({ kind: 'registered' });
  if (await ports.isLocalFirst()) return Object.freeze({ kind: 'local-first' });
  const compatibility = ports.readCompatibility();
  if (compatibility?.policy.accessPolicy === 1
    && compatibility.roster !== null
    && compatibility.policy.source.kind === 'owner-signed-unregistered') {
    return Object.freeze({ kind: 'compatibility', snapshot: compatibility });
  }
  // Neither approval nor a signed replica seed may substitute for a finalized
  // name-index absence. Public metadata alone is never an authority source.
  if (!ports.finalizedAbsence) return Object.freeze({ kind: 'registered' });
  const approved = await ports.resolveApprovedPrivate();
  if (approved !== null) return Object.freeze({ kind: 'approved-private', ...approved });
  const replica = await ports.loadReplicaSeed();
  return replica === null ? null : Object.freeze({ kind: 'replica-seed', snapshot: replica });
}
