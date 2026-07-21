import {
  createWalRuntime,
  disabledWalRuntimeStatus,
  parseWalSyncMode,
  resolveWalRuntimeConfiguration,
  type WalRuntime,
  type WalRuntimeStatus,
} from '@origintrail-official/dkg-wal';
import type { DkgConfig } from './config.js';

export const WAL_SYNC_MODE_ENV = 'DKG_WAL_SYNC_MODE';

export function applyWalSyncModeOverride(
  env: NodeJS.ProcessEnv,
  value: unknown,
): ReturnType<typeof parseWalSyncMode> | null {
  if (value === undefined || value === null || value === '') {
    delete env[WAL_SYNC_MODE_ENV];
    return null;
  }
  const mode = parseWalSyncMode(value);
  env[WAL_SYNC_MODE_ENV] = mode;
  return mode;
}

export function resolveDaemonWalRuntimeConfiguration(
  config: Pick<DkgConfig, 'sync'>,
  dkgHome: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const rawOverride = env[WAL_SYNC_MODE_ENV];
  return resolveWalRuntimeConfiguration({
    dkgHome,
    sync: config.sync,
    modeOverride: rawOverride?.trim() ? rawOverride.trim() : undefined,
  });
}

export async function startDaemonWalRuntime(
  config: Pick<DkgConfig, 'sync'>,
  dkgHome: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WalRuntime | null> {
  const runtime = createWalRuntime(resolveDaemonWalRuntimeConfiguration(config, dkgHome, env));
  await runtime?.start();
  return runtime;
}

export function daemonWalRuntimeStatus(runtime: WalRuntime | null): WalRuntimeStatus {
  return runtime?.status() ?? disabledWalRuntimeStatus();
}
