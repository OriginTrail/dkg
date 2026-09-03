import type { RecoveryExecutionGuard } from
  '../src/sync/requester/recovery-execution-guard.js';
import type { SharedMemoryMetadataFetcher } from
  '../src/sync/requester/shared-memory-sync.js';
import type { PublicSwmTargetV1 } from
  '../src/sync/requester/swm-target-executor.js';

declare const base: Omit<PublicSwmTargetV1, 'mode'>;
declare const recoveryGuard: RecoveryExecutionGuard;
declare const metadataFetcher: SharedMemoryMetadataFetcher;

const ordinary: PublicSwmTargetV1 = {
  ...base,
  mode: { kind: 'ordinary' },
};

const selected: PublicSwmTargetV1 = {
  ...base,
  mode: { kind: 'selected-recovery', recoveryGuard, metadataFetcher },
};

void ordinary;
void selected;

const selectedWithoutGuard: PublicSwmTargetV1 = {
  ...base,
  // @ts-expect-error Selected recovery cannot omit its mandatory lease.
  mode: { kind: 'selected-recovery', metadataFetcher },
};

const ordinaryWithRecoveryState: PublicSwmTargetV1 = {
  ...base,
  // @ts-expect-error Ordinary synchronization cannot carry recovery capabilities.
  mode: { kind: 'ordinary', recoveryGuard, metadataFetcher },
};

void selectedWithoutGuard;
void ordinaryWithRecoveryState;
