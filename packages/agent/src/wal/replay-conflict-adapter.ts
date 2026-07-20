import {
  WalReplayConflictAdapterV1,
  type ReplayAdmittedWalSetInputV1,
  type WalReplayLimitsV1,
  type WalReplayMergeInputV1,
  type WalReplayProjectionV1,
  type WalReplaySemanticCoreV1,
  type WalReplaySemanticDecisionV1,
  type WalReplaySemanticStateV1,
  type WalReplayTransitionInputV1,
} from '@origintrail-official/dkg-wal/replay';
import {
  dkgSemanticCore,
  type DkgSemanticCore,
  type DkgSemanticDriver,
} from '../semantic/dkg-semantic-core.js';

type ReplayDriver = Extract<DkgSemanticDriver, 'legacy-sync' | 'wal-sync'>;

export interface DkgWalReplayCoreAdapterOptionsV1<Projection> {
  /** The one existing semantic implementation used by both sync drivers. */
  readonly implementation: WalReplaySemanticCoreV1<Projection>;
  readonly driver: ReplayDriver;
  readonly semanticCore?: DkgSemanticCore;
}

/**
 * Agent-side bridge from protocol replay orchestration to DkgSemanticCore.
 * It forwards calls and observability context only; it owns no DKG behavior.
 */
export class DkgWalReplayCoreAdapterV1<Projection>
implements WalReplaySemanticCoreV1<Projection> {
  private readonly semanticCore: DkgSemanticCore;

  constructor(private readonly options: DkgWalReplayCoreAdapterOptionsV1<Projection>) {
    this.semanticCore = options.semanticCore ?? dkgSemanticCore;
  }

  initialState(input: {
    readonly namespaceId: Uint8Array;
    readonly logicalKey: Uint8Array;
  }): Promise<WalReplaySemanticStateV1<Projection>> {
    return this.semanticCore.invokeWalReplaySemanticEntryPoint(
      this.options.driver,
      'wal-replay-initial-state',
      () => this.options.implementation.initialState(input),
    );
  }

  evaluateTransition(
    input: WalReplayTransitionInputV1<Projection>,
  ): Promise<WalReplaySemanticDecisionV1<Projection>> {
    return this.semanticCore.invokeWalReplaySemanticEntryPoint(
      this.options.driver,
      'wal-replay-transition',
      () => this.options.implementation.evaluateTransition(input),
    );
  }

  mergeCompatibleBranches(
    input: WalReplayMergeInputV1<Projection>,
  ): Promise<WalReplaySemanticDecisionV1<Projection>> {
    return this.semanticCore.invokeWalReplaySemanticEntryPoint(
      this.options.driver,
      'wal-replay-compatible-merge',
      () => this.options.implementation.mergeCompatibleBranches(input),
    );
  }
}

export interface ReplayAdmittedWalSetWithDkgCoreOptionsV1<Projection> {
  /** Existing shared implementation, never a WAL-specific rule set. */
  readonly implementation: WalReplaySemanticCoreV1<Projection>;
  readonly input: ReplayAdmittedWalSetInputV1;
  readonly limits?: Partial<WalReplayLimitsV1>;
  readonly semanticCore?: DkgSemanticCore;
}

export async function replayAdmittedWalSetWithDkgCoreV1<Projection>(
  options: ReplayAdmittedWalSetWithDkgCoreOptionsV1<Projection>,
): Promise<WalReplayProjectionV1<Projection>> {
  const bridge = new DkgWalReplayCoreAdapterV1({
    implementation: options.implementation,
    driver: 'wal-sync',
    semanticCore: options.semanticCore,
  });
  return new WalReplayConflictAdapterV1(bridge, options.limits).replay(options.input);
}
