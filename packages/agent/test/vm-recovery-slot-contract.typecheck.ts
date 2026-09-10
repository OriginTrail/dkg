import type { VmReconcileRotationRecord, VmRecoverySlotRegistry } from '../src/internal/vm-recovery-slot-registry.js';

declare const record: VmReconcileRotationRecord;
declare const registry: VmRecoverySlotRegistry;

// @ts-expect-error Rotation phase changes belong to the registry.
record.phase = 'backoff';
// @ts-expect-error Consumers cannot rewrite retry epochs.
record.nextRetryAt = Infinity;
// @ts-expect-error Peer evidence is observational; transitions are registry commands.
record.attemptedPeerIds.add('uncontacted-peer');
// @ts-expect-error Diagnostic membership cannot install a record.
registry.snapshot().set('unowned', record);
