import type { PreparedSnapshotCheckpoint, VerifiedNativeSnapshotCheckpoint } from '../src/snapshot-checkpoint-contract.js';
import type { preparePublicSnapshotCheckpoint } from '../src/public-snapshot-checkpoint.js';
import type { buildNativeSnapshotCheckpoint } from '../src/snapshot-native-build.js';
import type { createFreshPublicCheckpointEdge } from '../src/snapshot-fresh-edge.js';
import type { DKGAgent, PublicCheckpointPreparationResult } from '../src/index.js';

declare const publicResult: Awaited<ReturnType<DKGAgent['preparePublicGraphCheckpoint']>>;
const publicContract: PublicCheckpointPreparationResult = publicResult;
const committed: 0 = publicResult.committed;
const current: false = publicResult.current;
const changed: false = publicResult.activeStoreChanged;
const state: 'verified-unpublished' = publicResult.state;
void [publicContract, committed, current, changed, state];

declare const prepared: Awaited<ReturnType<typeof preparePublicSnapshotCheckpoint>>;
declare const built: Awaited<ReturnType<typeof buildNativeSnapshotCheckpoint>>;
const manifestVersion: 1 = prepared.manifest.version;
const nativeState: 'verified-unpublished' = built.state;
const handoff: VerifiedNativeSnapshotCheckpoint = { version: 1, state: 'verified-unpublished', fullReadback: true,
  journal: '/checkpoint/store.jnl', journalSha256: 'digest', inventoryDigest: 'inventory', runtimeSha256: 'runtime',
  propertiesSha256: 'properties', current: false, activeStoreChanged: false };
const preparedInput: PreparedSnapshotCheckpoint = prepared;
const activation: Pick<Parameters<typeof createFreshPublicCheckpointEdge>[0], 'prepared' | 'native'> = {
  prepared: preparedInput, native: handoff, // Does not require producer timing or diagnostic fields.
};
// @ts-expect-error Only verified, unpublished native evidence can cross activation.
const wrongState: VerifiedNativeSnapshotCheckpoint = { ...handoff, state: 'loading' };
// @ts-expect-error Full audit is required; samples cannot authorize activation.
const sampled: VerifiedNativeSnapshotCheckpoint = { ...handoff, fullReadback: false };
void [manifestVersion, nativeState, activation, wrongState, sampled];
