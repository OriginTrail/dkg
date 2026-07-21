import type {
  WalLegacyGenesisDecisionV1,
  WalMigrationSemanticCoreV1,
} from '@origintrail-official/dkg-wal';
import {
  dkgSemanticCore,
  type DkgSemanticCore,
  type DkgSemanticDriver,
} from '../semantic/dkg-semantic-core.js';

type MigrationDriver = Extract<DkgSemanticDriver, 'legacy-sync' | 'wal-sync'>;

export interface DkgWalMigrationSemanticAdapterOptionsV1 {
  /** Existing migration-policy implementation shared by both sync drivers. */
  readonly implementation: WalMigrationSemanticCoreV1;
  readonly driver: MigrationDriver;
  readonly semanticCore?: DkgSemanticCore;
}

/**
 * Observability-only bridge for LegacyGenesisV1 quarantine/visibility.
 * It contains no DKG authorization, SWM/VM, verified-memory, or crypto rule.
 */
export class DkgWalMigrationSemanticAdapterV1 implements WalMigrationSemanticCoreV1 {
  private readonly semanticCore: DkgSemanticCore;

  constructor(private readonly options: DkgWalMigrationSemanticAdapterOptionsV1) {
    this.semanticCore = options.semanticCore ?? dkgSemanticCore;
  }

  authorizeLegacyGenesis(
    input: Parameters<WalMigrationSemanticCoreV1['authorizeLegacyGenesis']>[0],
  ): Promise<WalLegacyGenesisDecisionV1> {
    return this.semanticCore.invokeWalMigrationSemanticEntryPoint(
      this.options.driver,
      'wal-legacy-genesis-authorization',
      () => this.options.implementation.authorizeLegacyGenesis(input),
    );
  }
}

export function createDkgWalMigrationSemanticAdapterV1(
  options: DkgWalMigrationSemanticAdapterOptionsV1,
): DkgWalMigrationSemanticAdapterV1 {
  return new DkgWalMigrationSemanticAdapterV1(options);
}
