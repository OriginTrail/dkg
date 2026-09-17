import type { VmRecoveryRotationSnapshot, VmRecoverySlotHandle, VmRecoverySlotRegistry } from '../src/internal/vm-recovery-slot-registry.js';

declare const snapshot: VmRecoveryRotationSnapshot;
declare const handle: VmRecoverySlotHandle;
declare const registry: VmRecoverySlotRegistry;
declare const target: Parameters<VmRecoverySlotRegistry['read']>[0];

// @ts-expect-error Snapshot fields are immutable.
snapshot.phase = 'backoff';
// @ts-expect-error Snapshot membership is immutable.
snapshot.attemptedPeerIds.push('uncontacted-peer');
// @ts-expect-error Read models cannot authorize writes.
registry.isCurrent(target, snapshot);
// @ts-expect-error Ordinary symbols cannot impersonate an issued handle.
registry.isCurrent(target, Symbol('forged'));
// @ts-expect-error Command handles do not expose rotation state.
void handle.phase;
// @ts-expect-error Diagnostic membership cannot install a record.
registry.snapshot().set('unowned', snapshot);
