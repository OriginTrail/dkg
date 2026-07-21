import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { Quad, QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import {
  authenticateVerifiedGraphScopedAsset,
  materializeVerifiedGraphScopedAsset,
  type GraphScopedMaterializationOutcome,
  type VerifiedGraphScopedAsset,
} from '../sync/requester/graph-scoped-materialization.js';
import {
  applySwmRecovery,
  type SwmRecoveryApplyResult,
  type SwmRecoveryRoot,
  type SwmRecoveryStore,
} from '../sync/requester/swm-recovery-apply.js';
import {
  reconcileContextGraph,
  type ChainReconcilerDeps,
  type ReconcileResult,
} from '../chain-reconciler.js';
import type { CursorState } from '../reconcile-cursor.js';
import type { OversizeGuardHooks } from '../sync/oversize-filter.js';
import {
  validateCurrentDkgVmChainEvidenceV1,
  type ValidateCurrentDkgVmChainEvidenceInputV1,
  type DkgVmChainValidationResultV1,
} from './vm-chain-validator.js';

/**
 * The driver identifies how bytes reached the semantic boundary. It is
 * observability context only and MUST NOT select different DKG behavior.
 */
export type DkgSemanticDriver =
  | 'local-command'
  | 'legacy-sync'
  | 'wal-sync'
  | 'chain-event';

export type DkgSemanticEntryPoint =
  | 'verified-graph-scoped-materialization'
  | 'verified-swm-recovery'
  | 'vm-reconciliation'
  | 'vm-chain-evidence-validation'
  | 'vm-evidence-application'
  | 'wal-replay-initial-state'
  | 'wal-replay-transition'
  | 'wal-replay-compatible-merge'
  | 'wal-delete-expiry-authorization'
  | 'wal-snapshot-baseline-entry-validation'
  | 'wal-snapshot-baseline-conflict-validation'
  | 'wal-legacy-genesis-authorization';

export type DkgWalReplaySemanticEntryPoint = Extract<
  DkgSemanticEntryPoint,
  | 'wal-replay-initial-state'
  | 'wal-replay-transition'
  | 'wal-replay-compatible-merge'
>;

export type DkgWalRetentionSemanticEntryPoint = Extract<
  DkgSemanticEntryPoint,
  | 'wal-delete-expiry-authorization'
  | 'wal-snapshot-baseline-entry-validation'
  | 'wal-snapshot-baseline-conflict-validation'
>;

export type DkgWalMigrationSemanticEntryPoint = Extract<
  DkgSemanticEntryPoint,
  'wal-legacy-genesis-authorization'
>;

export interface DkgSemanticCoreTraceEvent {
  readonly driver: DkgSemanticDriver;
  readonly entryPoint: DkgSemanticEntryPoint;
  readonly phase: 'enter' | 'return' | 'throw';
}

export type DkgSemanticCoreObserver = (event: DkgSemanticCoreTraceEvent) => void;

export interface DkgSemanticCoreDelegates {
  readonly authenticateVerifiedGraphScopedAsset: typeof authenticateVerifiedGraphScopedAsset;
  readonly materializeVerifiedGraphScopedAsset: typeof materializeVerifiedGraphScopedAsset;
  readonly applySwmRecovery: typeof applySwmRecovery;
  readonly reconcileContextGraph: typeof reconcileContextGraph;
  readonly validateCurrentDkgVmChainEvidenceV1: typeof validateCurrentDkgVmChainEvidenceV1;
}

export interface DkgSemanticCoreOptions {
  /** Test/audit seam only. Production uses the existing functions below. */
  readonly delegates?: Partial<DkgSemanticCoreDelegates>;
  readonly observer?: DkgSemanticCoreObserver;
}

export interface ApplyVerifiedGraphScopedAssetParams {
  readonly chain: ChainAdapter;
  readonly store: TripleStore;
  readonly asset: VerifiedGraphScopedAsset;
  readonly resolveOnChainContextGraphId?: (contextGraphId: string) => Promise<string | null>;
  readonly receivedAt?: Date;
  readonly options?: QueryOptions;
  readonly oversizeHooks?: OversizeGuardHooks;
}

export interface ApplyVerifiedGraphScopedAssetResult {
  readonly authenticatedAsset: VerifiedGraphScopedAsset;
  readonly outcome: GraphScopedMaterializationOutcome;
}

export interface ApplyVerifiedSwmRecoveryParams {
  readonly store: SwmRecoveryStore;
  readonly verifiedData: readonly Quad[];
  readonly roots: readonly SwmRecoveryRoot[];
}

export interface ReconcileVmParams {
  readonly deps: ChainReconcilerDeps;
  readonly state: CursorState;
  readonly localContextGraphId: string;
  readonly onChainContextGraphId: bigint;
}

const DEFAULT_DELEGATES: DkgSemanticCoreDelegates = {
  authenticateVerifiedGraphScopedAsset,
  materializeVerifiedGraphScopedAsset,
  applySwmRecovery,
  reconcileContextGraph,
  validateCurrentDkgVmChainEvidenceV1,
};

/**
 * Narrow adapter over the existing DKG semantic implementation.
 *
 * It owns no authorization table, SWM/VM model, verified-memory rule, crypto
 * rule, conflict winner, or RDF behavior. Both synchronization mechanisms call
 * these same methods; `driver` is trace metadata and never participates in
 * dispatch. The WAL package deliberately cannot import this module because the
 * dependency direction is agent -> WAL, never WAL -> agent.
 */
export class DkgSemanticCore {
  private readonly delegates: DkgSemanticCoreDelegates;
  private readonly observer?: DkgSemanticCoreObserver;

  constructor(options: DkgSemanticCoreOptions = {}) {
    this.delegates = { ...DEFAULT_DELEGATES, ...options.delegates };
    this.observer = options.observer;
  }

  async applyVerifiedGraphScopedAsset(
    driver: DkgSemanticDriver,
    params: ApplyVerifiedGraphScopedAssetParams,
  ): Promise<ApplyVerifiedGraphScopedAssetResult> {
    return this.invoke(driver, 'verified-graph-scoped-materialization', async () => {
      const authenticatedAsset = await this.delegates.authenticateVerifiedGraphScopedAsset(
        params.chain,
        params.asset,
        params.resolveOnChainContextGraphId,
        params.receivedAt,
      );
      const outcome = await this.delegates.materializeVerifiedGraphScopedAsset({
        store: params.store,
        asset: authenticatedAsset,
        options: params.options,
        oversizeHooks: params.oversizeHooks,
      });
      return { authenticatedAsset, outcome };
    });
  }

  async applyVerifiedSwmRecovery(
    driver: DkgSemanticDriver,
    params: ApplyVerifiedSwmRecoveryParams,
  ): Promise<SwmRecoveryApplyResult> {
    return this.invoke(
      driver,
      'verified-swm-recovery',
      () => this.delegates.applySwmRecovery(params),
    );
  }

  async reconcileVm(
    driver: DkgSemanticDriver,
    params: ReconcileVmParams,
  ): Promise<ReconcileResult> {
    return this.invoke(
      driver,
      'vm-reconciliation',
      () => this.delegates.reconcileContextGraph(
        params.deps,
        params.state,
        params.localContextGraphId,
        params.onChainContextGraphId,
      ),
    );
  }

  async validateVmChainEvidence(
    driver: DkgSemanticDriver,
    params: ValidateCurrentDkgVmChainEvidenceInputV1,
  ): Promise<DkgVmChainValidationResultV1> {
    return this.invoke(
      driver,
      'vm-chain-evidence-validation',
      () => this.delegates.validateCurrentDkgVmChainEvidenceV1(params),
    );
  }

  /**
   * Invoke the existing VM/SWM semantic implementation after chain evidence
   * has been normalized. The operation is supplied by the existing semantic
   * owner; this boundary adds only driver-independent tracing.
   */
  async invokeVmSemanticEntryPoint<T>(
    driver: Extract<DkgSemanticDriver, 'legacy-sync' | 'wal-sync' | 'chain-event'>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.invoke(driver, 'vm-evidence-application', operation);
  }

  /**
   * Trace and invoke one WAL replay call through this same shared boundary.
   * The supplied operation is an existing semantic-core implementation; this
   * method does not interpret the candidate or select a different function by
   * synchronization driver.
   */
  async invokeWalReplaySemanticEntryPoint<T>(
    driver: Extract<DkgSemanticDriver, 'legacy-sync' | 'wal-sync'>,
    entryPoint: DkgWalReplaySemanticEntryPoint,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.invoke(driver, entryPoint, operation);
  }

  /**
   * Trace and invoke existing delete/expiry and snapshot-baseline semantics.
   * WAL supplies authenticated protocol inputs but owns no DKG decision.
   */
  async invokeWalRetentionSemanticEntryPoint<T>(
    driver: Extract<DkgSemanticDriver, 'legacy-sync' | 'wal-sync'>,
    entryPoint: DkgWalRetentionSemanticEntryPoint,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.invoke(driver, entryPoint, operation);
  }

  /**
   * Trace the existing migration-policy decision. The supplied implementation
   * owns provenance visibility; this boundary never promotes legacy state.
   */
  async invokeWalMigrationSemanticEntryPoint<T>(
    driver: Extract<DkgSemanticDriver, 'legacy-sync' | 'wal-sync'>,
    entryPoint: DkgWalMigrationSemanticEntryPoint,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.invoke(driver, entryPoint, operation);
  }

  private async invoke<T>(
    driver: DkgSemanticDriver,
    entryPoint: DkgSemanticEntryPoint,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.observer?.({ driver, entryPoint, phase: 'enter' });
    try {
      const result = await operation();
      this.observer?.({ driver, entryPoint, phase: 'return' });
      return result;
    } catch (error) {
      this.observer?.({ driver, entryPoint, phase: 'throw' });
      throw error;
    }
  }
}

/** One stateless production boundary shared by current sync and WAL replay. */
export const dkgSemanticCore = new DkgSemanticCore();
