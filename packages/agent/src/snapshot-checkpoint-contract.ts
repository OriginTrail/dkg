// SPDX-License-Identifier: Apache-2.0
import type { PublicSnapshotMode, PublicSnapshotObservation } from './public-snapshot-evidence.js';
import type { SnapshotCheckpointEntry } from './snapshot-checkpoint-files.js';
import type { VerifiedSnapshotCheckpointAsset } from './snapshot-checkpoint-verify.js';

/** Authenticated, isolated input; never live Edge coverage or replacement permission. */
export interface SnapshotCheckpointManifest {
  version: 1; state: 'verified-unpublished';
  observation: PublicSnapshotObservation; freshObservation: PublicSnapshotObservation;
  sourcePeer: string; entries: SnapshotCheckpointEntry[]; assets: VerifiedSnapshotCheckpointAsset[];
  trustSha256: string; encodedBytes: number; plainBytes: number; preparedAt: number; deadline: number;
}
export interface PreparedSnapshotCheckpoint {
  directory: string; manifest: SnapshotCheckpointManifest; committed: 0; current: false;
}
export interface SnapshotCheckpointAudit {
  assets: number; publicQuads: number; fullReadback: true;
}
/** Only activation evidence belongs to the handoff; timing/count reports are separate. */
export interface VerifiedNativeSnapshotCheckpoint {
  version: 1; state: 'verified-unpublished'; fullReadback: true;
  journal: string; journalSha256: string; inventoryDigest: string;
  runtimeSha256: string; propertiesSha256: string; current: false; activeStoreChanged: false;
}
export interface NativeSnapshotCheckpointReport extends VerifiedNativeSnapshotCheckpoint {
  assets: number; publicQuads: number; loaderMs: number; elapsedMs: number;
}
/** Public preparation/job result. It never confers live coverage or store ownership. */
export interface PublicCheckpointPreparationResult {
  directory: string; assets: number; inventoryDigest: string; mode: PublicSnapshotMode;
  committed: 0; current: false; activeStoreChanged: false; state: 'verified-unpublished';
  native?: NativeSnapshotCheckpointReport;
}
