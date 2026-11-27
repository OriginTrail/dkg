import { normalizePublicSnapshotSyncOptions, type PublicSnapshotSyncOptions } from '../dist/index.js';

const scope = { contextGraphId: 'public', onChainId: '14' };
const explicit: PublicSnapshotSyncOptions = { ...scope, trustedCorePeerIds: ['core'] };
const registered: PublicSnapshotSyncOptions = { ...scope, trustedCorePeerIds: [], sourcePolicy: 'base-mainnet-registered-cores' };
// @ts-expect-error Explicit peers and automatic source discovery are mutually exclusive.
const mixed: PublicSnapshotSyncOptions = { ...scope, trustedCorePeerIds: ['core'], sourcePolicy: 'base-mainnet-registered-cores' };
const dynamicPeers: readonly string[] = [];
// @ts-expect-error An arbitrary array is not known to be empty under the registered-core policy.
const dynamic: PublicSnapshotSyncOptions = { ...scope, trustedCorePeerIds: dynamicPeers, sourcePolicy: 'base-mainnet-registered-cores' };
const normalized = normalizePublicSnapshotSyncOptions(registered);
if (normalized.sourcePolicy) {
  const empty: readonly [] = normalized.trustedCorePeerIds;
  void empty;
}
void [explicit, registered, mixed, dynamic];
