import type { RecoveryExecutionGuard } from
  '../src/sync/requester/recovery-execution-guard.js';
import type { SharedMemoryMetadataFetcher } from
  '../src/sync/requester/shared-memory-sync.js';
import type { SharedMemorySyncContext } from
  '../src/sync/requester/shared-memory-sync.js';
import type { PublicSwmTargetV1 } from
  '../src/sync/requester/swm-target-executor.js';

declare const base: Omit<PublicSwmTargetV1, 'mode' | 'metadataFetcher'>;
declare const recoveryGuard: RecoveryExecutionGuard;
declare const metadataFetcher: SharedMemoryMetadataFetcher;

const ordinary: PublicSwmTargetV1 = {
  ...base,
  metadataFetcher,
  mode: { kind: 'ordinary' },
};

const selected: PublicSwmTargetV1 = {
  ...base,
  metadataFetcher,
  mode: { kind: 'selected-recovery', recoveryGuard },
};

void ordinary;
void selected;

const selectedWithoutGuard: PublicSwmTargetV1 = {
  ...base,
  metadataFetcher,
  // @ts-expect-error Selected recovery cannot omit its mandatory lease.
  mode: { kind: 'selected-recovery' },
};

const ordinaryWithRecoveryState: PublicSwmTargetV1 = {
  ...base,
  metadataFetcher,
  // @ts-expect-error Ordinary synchronization cannot carry recovery capabilities.
  mode: { kind: 'ordinary', recoveryGuard },
};

void selectedWithoutGuard;
void ordinaryWithRecoveryState;

// Public lifecycle targets always carry a transfer session, regardless of algorithm.
// @ts-expect-error The ordinary lifecycle path cannot bypass retained metadata.
const ordinaryWithoutMetadata: PublicSwmTargetV1 = { ...base, mode: { kind: 'ordinary' } };
// @ts-expect-error Selected lifecycle execution also requires the independent transfer capability.
const selectedWithoutMetadata: PublicSwmTargetV1 = { ...base, mode: { kind: 'selected-recovery', recoveryGuard } };
void ordinaryWithoutMetadata;
void selectedWithoutMetadata;

declare const requesterBase: Omit<SharedMemorySyncContext, 'mode'>;

const ordinaryRequester: SharedMemorySyncContext = {
  ...requesterBase,
  mode: { kind: 'ordinary' },
};

const selectedRequester: SharedMemorySyncContext = {
  ...requesterBase,
  mode: {
    kind: 'selected-recovery',
    recoveryGuard,
    metadataFetcher,
    snapshotRecoveryOrder: 'recent-balanced',
  },
};

const requesterWithoutGuard: SharedMemorySyncContext = {
  ...requesterBase,
  // @ts-expect-error The requester boundary also requires a selected-recovery lease.
  mode: {
    kind: 'selected-recovery',
    metadataFetcher,
    snapshotRecoveryOrder: 'recent-balanced',
  },
};

const ordinaryRequesterWithRecoveryState: SharedMemorySyncContext = {
  ...requesterBase,
  // @ts-expect-error Ordinary requester mode cannot carry selected-recovery capabilities.
  mode: { kind: 'ordinary', recoveryGuard, metadataFetcher },
};

void ordinaryRequester;
void selectedRequester;
void requesterWithoutGuard;
void ordinaryRequesterWithRecoveryState;
