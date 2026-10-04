// SPDX-License-Identifier: Apache-2.0

/** Daemon boot, runtime and shutdown wiring for external-store monitoring. */
import { isExternalBackend } from '@origintrail-official/dkg-storage';
import {
  checkExternalStoreReachable,
  formatHealthCheckFailure,
  type StoreHealthCheckOptions,
} from './store-health-check.js';
import {
  attemptManagedStoreBootRecovery,
  createStoreRuntimeMonitor,
  resolveManagedBlazegraphContainer,
  storeBootRestartTsPath,
  storeHardenLockPath,
} from './store-runtime-monitor.js';
import type { daemonState } from './state.js';

type StoreMonitorState = Pick<typeof daemonState, 'storeMonitor'>;
type StoreConfig = StoreHealthCheckOptions['storeConfig'];

export async function ensureStoreReachableAtBoot(
  storeConfig: StoreConfig,
  dkgHome: string,
  log: (message: string) => void,
): Promise<void> {
  let health = await checkExternalStoreReachable({ storeConfig });
  if (!health.ok) {
    // Managed Blazegraph gets ONE docker-restart attempt before the
    // exit(1): the 2026-07-18 wedge showed exit-looping the daemon
    // against an alive-but-deaf store (probe fails → exit → systemd
    // restarts the daemon → same wedged store) heals nothing, while a
    // container restart does. Operator-managed stores keep the
    // fail-fast behaviour unchanged.
    const managedBlazegraphContainer = resolveManagedBlazegraphContainer(storeConfig);
    if (managedBlazegraphContainer) {
      log(
        `[STORE-HEALTH] managed Blazegraph unreachable at boot — attempting one ` +
        `docker restart of ${managedBlazegraphContainer}`,
      );
      await attemptManagedStoreBootRecovery({
        storeConfig,
        managedContainerName: managedBlazegraphContainer,
        log,
        // Never restart the container while `dkg store harden` holds its
        // lock (it deliberately stopped the container mid-migration).
        hardenLockPath: storeHardenLockPath(dkgHome),
        // Cross-process cooldown: under systemd Restart=always a slow
        // cold-starting store must not be kicked back to second zero by
        // every daemon boot — at most one container-restart per 30 min;
        // otherwise this call only waits for the store to come up.
        restartCooldownFilePath: storeBootRestartTsPath(dkgHome),
      });
      health = await checkExternalStoreReachable({ storeConfig });
    }
  }
  if (!health.ok) {
    log(formatHealthCheckFailure(health));
    process.exit(1);
  }
  log(`External triple-store reachable: ${health.backend} ${health.endpoint}`);
}

export function startDaemonStoreMonitor(opts: {
  storeConfig: StoreConfig;
  dkgHome: string;
  state: StoreMonitorState;
  log: (message: string) => void;
}): void {
  // Runtime store monitor (store.monitor.*, 2026-07-18 mainnet wedge):
  // periodic ASK probe against the external store with a bounded
  // auto-restart for the daemon-managed Blazegraph container. Managed
  // oxigraph-server has its own revive lifecycle (oxigraph-managed.ts),
  // so it — like operator-managed stores — is monitored log-only
  // (managedContainerName stays null → docker is never touched).
  if (!isExternalBackend(opts.storeConfig?.backend) || process.env.DKG_STORE_MONITOR_DISABLED === '1') return;
  const storeMonitor = createStoreRuntimeMonitor({
    storeConfig: opts.storeConfig,
    managedContainerName: resolveManagedBlazegraphContainer(opts.storeConfig),
    // `dkg store harden` stops the managed container for a multi-minute
    // journal export; while its lock file exists the monitor must not
    // issue docker restarts (store.monitor.suspended-by-harden).
    hardenLockPath: storeHardenLockPath(opts.dkgHome),
    log: opts.log,
  });
  storeMonitor.start();
  opts.state.storeMonitor = storeMonitor;
}

export function stopDaemonStoreMonitor(state: StoreMonitorState): void {
  state.storeMonitor?.stop();
  state.storeMonitor = null;
}
