import {
  loadConfig,
  loadNetworkConfig,
  loadResolvedNetworkConfig,
  resolveUpdatePreferences,
} from '../config.js';
import {
  performNpmUpdate,
  performNpmUpdateEdge,
} from '../daemon/auto-update.js';
import { resolveStandaloneInstall } from '../daemon/state.js';
import { UPDATE_PREFLIGHT_CHECKS } from '../doctor/policy.js';
import type { RunDoctorOptions } from '../doctor/index.js';
import type { DoctorDeps, DoctorReport } from '../doctor/types.js';
import { getCurrentCliVersion } from './npm-version.js';
import { stopDaemonIfRunning } from './stop-daemon.js';

export type LoadedManualUpdateConfig = Awaited<ReturnType<typeof loadConfig>>;

export type ManualUpdateState = {
  config: LoadedManualUpdateConfig;
  context: {
    installMode: 'npm' | 'source';
    allowPrerelease: boolean;
    channel?: string;
  };
};

export type ManualUpdatePreflightResult =
  | { status: 'ok'; warnings?: string[] }
  | {
    status: 'blocked';
    findings: Array<{ check: string; message: string; advisory?: string }>;
  };

export type ManualUpdateInstallResult = 'updated' | 'failed' | 'daemon-running';

export type ManualUpdateDoctorOps = {
  createProductionDeps: (options?: { apiPort?: number }) => DoctorDeps;
  runDoctor: (deps: DoctorDeps, options?: RunDoctorOptions) => Promise<DoctorReport>;
};

export type ManualUpdateInstallerOps = {
  applyCore: typeof performNpmUpdate;
  applyEdge: typeof performNpmUpdateEdge;
  currentCliVersion: typeof getCurrentCliVersion;
  stopDaemon: typeof stopDaemonIfRunning;
};

async function loadManualUpdateDoctorOps(): Promise<ManualUpdateDoctorOps> {
  const { createProductionDeps, runDoctor } = await import('../doctor/index.js');
  return { createProductionDeps, runDoctor };
}

/** Resolve real local-over-network update policy independently of the polling enabled gate. */
export async function loadManualUpdateState(
  deps: {
    loadConfig?: () => Promise<LoadedManualUpdateConfig>;
    loadNetworkConfig?: typeof loadNetworkConfig;
    resolveInstallMode?: typeof resolveStandaloneInstall;
  } = {},
): Promise<ManualUpdateState> {
  const config = await (deps.loadConfig ?? loadConfig)();
  const { network } = await loadResolvedNetworkConfig(
    config,
    deps.loadNetworkConfig ?? loadNetworkConfig,
  );
  const preferences = resolveUpdatePreferences(config, network);
  return {
    config,
    context: {
      installMode: (deps.resolveInstallMode ?? resolveStandaloneInstall)(preferences.source)
        ? 'npm'
        : 'source',
      allowPrerelease: preferences.allowPrerelease,
      ...(preferences.channel ? { channel: preferences.channel } : {}),
    },
  };
}

export async function runDefaultUpdatePreflight(
  config: LoadedManualUpdateConfig,
  doctorOps?: ManualUpdateDoctorOps,
): Promise<ManualUpdatePreflightResult> {
  try {
    const ops = doctorOps ?? await loadManualUpdateDoctorOps();
    const preflightDeps = ops.createProductionDeps({ apiPort: config.apiPort ?? 9200 });
    const preflight = await ops.runDoctor(preflightDeps, {
      checks: UPDATE_PREFLIGHT_CHECKS,
    });
    if (preflight.exitCode === 2) {
      const errors = preflight.findings.filter((finding) => finding.severity === 'error');
      return {
        status: 'blocked',
        findings: errors.map((finding) => ({
          check: finding.check,
          message: finding.message,
          ...(finding.advisory ? { advisory: finding.advisory } : {}),
        })),
      };
    }
    return { status: 'ok' };
  } catch (err: any) {
    return {
      status: 'ok',
      warnings: [
        `[dkg update] WARNING: pre-flight doctor check crashed (${err?.message ?? err}); continuing without it.`,
      ],
    };
  }
}

/** Apply the role-specific installer, then stop the old daemon only after success. */
export async function applyManualUpdate(
  config: LoadedManualUpdateConfig,
  version: string,
  log: (message: string) => void,
  ops: ManualUpdateInstallerOps = {
    applyCore: performNpmUpdate,
    applyEdge: performNpmUpdateEdge,
    currentCliVersion: getCurrentCliVersion,
    stopDaemon: stopDaemonIfRunning,
  },
): Promise<ManualUpdateInstallResult> {
  const role = config.nodeRole ?? 'edge';
  log(
    `Updating to ${version} via NPM ` +
      `(${role === 'edge' ? 'global npm install' : 'blue-green slot'})...`,
  );
  const status = role === 'edge'
    ? await ops.applyEdge(version, ops.currentCliVersion(), log)
    : await ops.applyCore(version, log);
  if (status !== 'updated') return 'failed';
  return await ops.stopDaemon() ? 'updated' : 'daemon-running';
}
