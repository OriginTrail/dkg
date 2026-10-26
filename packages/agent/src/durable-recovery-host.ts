// SPDX-License-Identifier: Apache-2.0
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { SyncAdmissionSource, SyncContextGraphPriorityConfig } from './sync/policy.js';
import type { SyncOperationLane } from './sync/attempt-telemetry.js';
import type { SyncCheckpointStore } from './sync/checkpoint/state.js';
import type { DurableSyncContext, DurableSyncFetchRequest } from './sync/requester/durable-sync.js';
import type { StoreContentFence } from './internal/store-content-fence.js';
import type { HeldGraphScopedAssetsRequest } from './sync/requester/durable-data-holdings.js';
import type { ExactBatchStreamDriverPorts } from './sync/requester/exact-batch-stream-driver.js';
import type { DurableRecoveryAuthority, DurableRecoveryInput } from './durable-recovery-authority.js';
import type { RecoveryMaterialization, RecoveryMaterializationScope, RecoveryMaterializationPorts } from './durable-recovery-materialization.js';

export interface RecoveryAdmissionRequest<T> {
  readonly ctx: OperationContext;
  readonly contextGraphId: string;
  readonly lane: SyncOperationLane;
  readonly label: string;
  readonly work: () => Promise<T>;
  readonly priorityOverride?: number;
  readonly operationSignal?: AbortSignal;
  readonly source?: SyncAdmissionSource;
  readonly onWorkStarted?: () => void;
}

export type RecoveryStreamTransport = Omit<ExactBatchStreamDriverPorts,
  'verification' | 'isRegisteredPublic'>;

/** Consumer-owned operations: executors cannot reach agent storage, subscriptions or networking internals. */
export interface DurableRecoveryHost {
  /** Stable physical owner across adapters and exchanges. */
  readonly owner: object;
  policy(): {
    readonly syncAgentsMeta?: boolean;
    readonly syncContextGraphPriorities?: SyncContextGraphPriorityConfig;
  };
  readonly admission: { run<T>(request: RecoveryAdmissionRequest<T>): Promise<T> };
  readonly transport: {
    fetchPages(request: DurableSyncFetchRequest, options: {
      readonly assetUals?: string[];
      readonly forceFreshSession: boolean;
      readonly checkpointStore?: SyncCheckpointStore;
    }): ReturnType<DurableSyncContext['fetchSyncPages']>;
    stream(ctx: OperationContext, remotePeerId: string, contextGraphId: string): RecoveryStreamTransport;
  };
  readonly verification: {
    readonly processBatch: DurableSyncContext['processDurableBatchInWorker'];
    readonly parseAndFilter: ExactBatchStreamDriverPorts['verification']['parseAndFilter'];
  };
  readonly reconcile: RecoveryMaterializationPorts['reconcile'];
  readonly checkpoints: Pick<DurableSyncContext, 'deleteCheckpoint' | 'setCheckpoint'>;
  readonly log: {
    readonly info: DurableSyncContext['logInfo'];
    readonly warn: DurableSyncContext['logWarn'];
    readonly debug: DurableSyncContext['logDebug'];
  };
  readonly storeInsert: DurableSyncContext['storeInsert'];
  /** Which assets of a verified generation the store holds; a graph-owned round skips their DATA. */
  readonly heldStore?: {
    readonly read: (request: HeldGraphScopedAssetsRequest) => Promise<ReadonlySet<string>>;
    readonly withScope: StoreContentFence['withScope'];
    readonly openScope: StoreContentFence['openScope'];
    reconcile?(request: HeldGraphScopedAssetsRequest, held: ReadonlySet<string>, ctx: OperationContext): Promise<void>;
  };
  materialization(scope: RecoveryMaterializationScope): RecoveryMaterialization;
  resolveOrdinaryAuthority(ctx: OperationContext, input: DurableRecoveryInput): DurableRecoveryAuthority;
}
