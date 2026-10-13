import type { ManagedOxigraphRuntimeHooksV1 } from '@origintrail-official/dkg-storage';

const leaseHooks: ManagedOxigraphRuntimeHooksV1 = {
  registerActivity: () => ({ report(busy: boolean) { void busy; }, dispose() {} }),
};
const obsoleteHooks: ManagedOxigraphRuntimeHooksV1 = {
  // @ts-expect-error Activity is supplied only through a per-store lease.
  onBusyChange: (_busy: boolean) => {},
};
void leaseHooks;
void obsoleteHooks;

import type { OxigraphWalMaintenanceCoordinator, OxigraphWalMaintenanceOptions }
  from '../src/daemon/oxigraph-wal-maintenance.js';

type RecoveryRequired = {} extends Pick<OxigraphWalMaintenanceOptions, 'requestRecovery'> ? false : true;
const recoveryRequired: RecoveryRequired = true;
declare const maintenance: OxigraphWalMaintenanceCoordinator;
// @ts-expect-error Physical recovery progress is the only completion protocol.
maintenance.restartCompleted();
// @ts-expect-error Boolean restart requests cannot replace generation progress.
const obsoleteRestartOption: keyof OxigraphWalMaintenanceOptions = 'requestRestart';
void recoveryRequired;
void obsoleteRestartOption;
