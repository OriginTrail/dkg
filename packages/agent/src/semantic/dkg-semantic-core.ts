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
  | 'vm-reconciliation';

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
