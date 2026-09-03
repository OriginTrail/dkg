import { Command } from 'commander';

import {
  loadConfig,
  loadNetworkConfig,
  loadResolvedNetworkConfig,
  resolveUpdatePreferences,
} from '../config.js';
import {
  checkForNpmVersionUpdate,
  getCurrentCliVersion,
  performNpmUpdate,
  performNpmUpdateEdge,
  resolveStandaloneInstall,
} from '../daemon.js';
import { stopDaemonIfRunning } from '../cli-helpers.js';
import { UPDATE_PREFLIGHT_CHECKS } from '../doctor/policy.js';
import type { RunDoctorOptions } from '../doctor/index.js';
import type { DoctorDeps, DoctorReport } from '../doctor/types.js';
import { resolveExplicitNpmUpdateTarget } from '../update/npm-registry.js';

type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

export type ManualUpdatePreflightResult =
  | { status: 'ok'; warnings?: string[] }
  | {
    status: 'blocked';
    findings: Array<{ check: string; message: string; advisory?: string }>;
  };

export type ManualUpdateContext = {
  installMode: 'npm' | 'source';
  allowPrerelease: boolean;
  channel?: string;
};

export type ManualUpdateConfigurationPort = {
  load: () => Promise<LoadedConfig>;
  resolveContext: (config: LoadedConfig) => Promise<ManualUpdateContext>;
};

export type ManualUpdateRegistryPort = {
  resolveExplicitTarget: typeof resolveExplicitNpmUpdateTarget;
  checkForUpdate: typeof checkForNpmVersionUpdate;
};

export type ManualUpdateInstallerPort = {
  applyCore: typeof performNpmUpdate;
  applyEdge: typeof performNpmUpdateEdge;
  currentCliVersion: typeof getCurrentCliVersion;
  stopDaemon: typeof stopDaemonIfRunning;
};

export type ManualUpdatePreflightPort = {
  run: (config: LoadedConfig) => Promise<ManualUpdatePreflightResult>;
};

/** Cohesive workflow ports; orchestration does not own individual implementation functions. */
export type ManualUpdateServices = {
  configuration: ManualUpdateConfigurationPort;
  registry: ManualUpdateRegistryPort;
  installer: ManualUpdateInstallerPort;
  preflight: ManualUpdatePreflightPort;
};

export type ManualUpdateWorkflowOptions = {
  versionOrRef?: string;
  check?: boolean;
  allowPrerelease?: boolean;
};

export type ManualUpdateReporter = {
  writeStdout: (message: string) => void;
  writeStderr: (message: string) => void;
};

export type ManualUpdateWorkflowOutcome = {
  exitCode: 0 | 1 | 2;
};

const SILENT_REPORTER: ManualUpdateReporter = {
  writeStdout: () => undefined,
  writeStderr: () => undefined,
};

export type ManualUpdateDoctorOps = {
  createProductionDeps: (options?: { apiPort?: number }) => DoctorDeps;
  runDoctor: (deps: DoctorDeps, options?: RunDoctorOptions) => Promise<DoctorReport>;
};

async function loadManualUpdateDoctorOps(): Promise<ManualUpdateDoctorOps> {
  const { createProductionDeps, runDoctor } = await import('../doctor/index.js');
  return {
    createProductionDeps,
    runDoctor,
  };
}

async function loadResolvedManualUpdateContext(
  config: LoadedConfig,
): Promise<ManualUpdateContext> {
  const { network } = await loadResolvedNetworkConfig(config, loadNetworkConfig);
  const preferences = resolveUpdatePreferences(config, network);
  return {
    installMode: resolveStandaloneInstall(preferences.source) ? 'npm' : 'source',
    allowPrerelease: preferences.allowPrerelease,
    ...(preferences.channel ? { channel: preferences.channel } : {}),
  };
}

export async function runDefaultUpdatePreflight(
  config: LoadedConfig,
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

function createDefaultManualUpdateServices(): ManualUpdateServices {
  return {
    configuration: {
      load: loadConfig,
      resolveContext: loadResolvedManualUpdateContext,
    },
    registry: {
      resolveExplicitTarget: resolveExplicitNpmUpdateTarget,
      checkForUpdate: checkForNpmVersionUpdate,
    },
    installer: {
      applyCore: performNpmUpdate,
      applyEdge: performNpmUpdateEdge,
      currentCliVersion: getCurrentCliVersion,
      stopDaemon: stopDaemonIfRunning,
    },
    preflight: {
      run: runDefaultUpdatePreflight,
    },
  };
}

export async function runManualUpdateWorkflow(
  options: ManualUpdateWorkflowOptions,
  services: ManualUpdateServices = createDefaultManualUpdateServices(),
  reporter: ManualUpdateReporter = SILENT_REPORTER,
): Promise<ManualUpdateWorkflowOutcome> {
  const log = (message: string) => reporter.writeStdout(message);
  const error = (message: string) => reporter.writeStderr(message);
  const config = await services.configuration.load();
  const updateContext = await services.configuration.resolveContext(config);
  const standalone = updateContext.installMode === 'npm';
  const allowPre = options.allowPrerelease === true
    ? true
    : updateContext.allowPrerelease;

  if (standalone) {
    if (options.check) {
      log('Checking NPM registry for updates...');
      const check = await services.registry.checkForUpdate(
        log,
        allowPre,
        updateContext.channel,
      );
      if (check.status === 'available' && check.version) {
        log(`Update available: ${check.version}`);
      } else if (check.status === 'no-target') {
        log(`No acceptable target for channel "${check.channel}" (tag unpublished, or a pre-release rejected by allowPrerelease=false) — nothing to update to.`);
      } else if (check.status === 'up-to-date') {
        log('No updates available.');
      } else {
        error('Update check failed. See logs above for details.');
        return { exitCode: 1 };
      }
      return { exitCode: 0 };
    }

    const preflight = await services.preflight.run(config);
    for (const warning of preflight.status === 'ok' ? preflight.warnings ?? [] : []) {
      error(warning);
    }
    if (preflight.status === 'blocked') {
      error('\n[dkg update] Pre-flight checks failed; refusing to apply update.\n');
      for (const finding of preflight.findings) {
        error(`  • [${finding.check}] ${finding.message}`);
        if (finding.advisory) error(`      → ${finding.advisory}`);
      }
      error('\nRun `dkg doctor --json` for the full diagnostic report.\n');
      return { exitCode: 2 };
    }

    let version = options.versionOrRef ?? null;
    if (version) {
      version = version.replace(/^refs\/tags\/v?/, '').replace(/^v/, '');
    }
    if (version) {
      const gate = await services.registry.resolveExplicitTarget(version, allowPre);
      if (gate.status !== 'allowed') {
        error(`[dkg update] Refusing to update: ${gate.reason}.`);
        return { exitCode: 1 };
      }
      version = gate.version;
    }
    if (!version) {
      log('Checking NPM registry for updates...');
      const check = await services.registry.checkForUpdate(
        log,
        allowPre,
        updateContext.channel,
      );
      if (check.status === 'available' && check.version) {
        version = check.version;
      } else if (check.status === 'no-target') {
        log(`No acceptable target for channel "${check.channel}" (tag unpublished, or a pre-release rejected by allowPrerelease=false) — nothing to update to.`);
        return { exitCode: 0 };
      } else if (check.status === 'up-to-date') {
        log('No update needed — already on latest.');
        return { exitCode: 0 };
      } else {
        error('Update check failed. See logs above for details.');
        return { exitCode: 1 };
      }
    }

    const npmUpdateRole = config.nodeRole ?? 'edge';
    log(
      `Updating to ${version} via NPM ` +
        `(${npmUpdateRole === 'edge' ? 'global npm install' : 'blue-green slot'})...`,
    );
    const updateStatus = npmUpdateRole === 'edge'
      ? await services.installer.applyEdge(
        version,
        services.installer.currentCliVersion(),
        log,
      )
      : await services.installer.applyCore(version, log);
    if (updateStatus !== 'updated') {
      error('Update failed. Check logs and retry.');
      return { exitCode: 1 };
    }
    const stopped = await services.installer.stopDaemon();
    if (!stopped) {
      error('Update applied but old daemon is still running. Stop it manually and run "dkg start".');
      return { exitCode: 1 };
    }
    log('Update applied. Run "dkg start" to start with the new version.');
    return { exitCode: 0 };
  }

  error(
    '\n' +
    '[dkg update] ERROR: manual git-based update is not supported.\n' +
    '\n' +
    '  Manual `dkg update` flows through the npm registry.\n' +
    '  Advanced Core nodes may opt into daemon-polled git updates with\n' +
    '  autoUpdate.source = "git", repo, and branch/ref in config.json.\n' +
    '\n' +
    '  - Monorepo contributors: use `git pull && pnpm install && pnpm build`\n' +
    '    from the repo root. `dkg update` is for npm-installed nodes only.\n' +
    '  - install.sh-style operators: re-install via `npm install -g\n' +
    '    @origintrail-official/dkg`. The first daemon start records\n' +
    '    your existing slot version as the rollback target. Run\n' +
    '    `dkg doctor --json` for a diagnostic of your current layout.\n' +
    '  - Then re-run `dkg update` from a fresh `npm install -g\n' +
    '    @origintrail-official/dkg` install.\n' +
    '\n' +
    '  Guide: https://github.com/OriginTrail/dkg/blob/main/docs/use-dkg/updates-and-rollback.md\n' +
    '\n',
  );
  return { exitCode: 1 };
}

export function registerUpdateCommand(
  program: Command,
  services?: ManualUpdateServices,
  runtime: {
    writeStdout: (message: string) => void;
    writeStderr: (message: string) => void;
    setExitCode: (code: 1 | 2) => void;
  } = {
    writeStdout: (message) => console.log(message),
    writeStderr: (message) => console.error(message),
    setExitCode: (code) => { process.exitCode = code; },
  },
): void {
  program
    .command('update [versionOrRef]')
    .description('Check for and apply DKG node updates (blue-green swap)')
    .option('--check', 'Only check for updates, do not apply')
    .option('--allow-prerelease', 'Allow pre-release target versions')
    .option('--no-verify-tag', 'Skip signed-tag verification for version/tag updates')
    .action(async (
      versionOrRef: string | undefined,
      opts: { check?: boolean; allowPrerelease?: boolean },
    ) => {
      const outcome = await runManualUpdateWorkflow({
        versionOrRef,
        check: opts.check,
        allowPrerelease: opts.allowPrerelease,
      }, services, {
        writeStdout: runtime.writeStdout,
        writeStderr: runtime.writeStderr,
      });
      if (outcome.exitCode !== 0) runtime.setExitCode(outcome.exitCode);
    });
}
