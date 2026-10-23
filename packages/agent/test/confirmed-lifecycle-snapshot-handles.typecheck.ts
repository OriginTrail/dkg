import type { PreparedLifecycleSnapshot, LifecycleSnapshotLease } from '../src/named-ka-vm-lifecycle-snapshots.js';
import type { LifecycleRepairEntry } from '../src/named-ka-vm-lifecycle-repair-journal.js';

declare const handle: PreparedLifecycleSnapshot;
declare const lease: LifecycleSnapshotLease;
declare const entry: LifecycleRepairEntry;

const durableIdentity: PreparedLifecycleSnapshot = lease.handle;
entry.preparedSnapshot = durableIdentity;
lease.release();
// @ts-expect-error Durable identities expose no active lease to release.
handle.release();
// @ts-expect-error A lease cannot be stored as a durable identity.
entry.preparedSnapshot = lease;
