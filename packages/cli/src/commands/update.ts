import { Command } from 'commander';

import { checkForNpmVersionUpdate } from '../daemon.js';
import { resolveExplicitNpmUpdateTarget } from '../update/npm-registry.js';
import {
  applyManualUpdate,
  loadManualUpdateState,
  runDefaultUpdatePreflight,
  type LoadedManualUpdateConfig,
  type ManualUpdateInstallResult,
  type ManualUpdatePreflightResult,
  type ManualUpdateState,
} from '../update/manual-update.js';

type ManualUpdateWorkflowOptions = {
  versionOrRef?: string;
  check?: boolean;
  allowPrerelease?: boolean;
};

type ManualUpdateReporter = {
  writeStdout: (message: string) => void;
  writeStderr: (message: string) => void;
};

type ManualUpdateWorkflowOutcome = {
  exitCode: 0 | 1 | 2;
};

const SILENT_REPORTER: ManualUpdateReporter = {
  writeStdout: () => undefined,
  writeStderr: () => undefined,
};

/** One flat workflow boundary composed from focused production operations. */
export type ManualUpdateDependencies = {
  loadState: () => Promise<ManualUpdateState>;
  resolveExplicitTarget: typeof resolveExplicitNpmUpdateTarget;
  checkForUpdate: typeof checkForNpmVersionUpdate;
  runPreflight: (config: LoadedManualUpdateConfig) => Promise<ManualUpdatePreflightResult>;
  applyUpdate: (
    config: LoadedManualUpdateConfig,
    version: string,
    log: (message: string) => void,
  ) => Promise<ManualUpdateInstallResult>;
};

function createDefaultManualUpdateDependencies(): ManualUpdateDependencies {
  return {
    loadState: () => loadManualUpdateState(),
    resolveExplicitTarget: resolveExplicitNpmUpdateTarget,
    checkForUpdate: checkForNpmVersionUpdate,
    runPreflight: runDefaultUpdatePreflight,
    applyUpdate: applyManualUpdate,
  };
}

function consumeAutomaticCheck(
  check: Awaited<ReturnType<typeof checkForNpmVersionUpdate>>,
  checkOnly: boolean,
  reporter: ManualUpdateReporter,
): { status: 'target'; version: string } | { status: 'complete'; exitCode: 0 | 1 } {
  if (check.status === 'available' && check.version) {
    if (checkOnly) {
      reporter.writeStdout(`Update available: ${check.version}`);
      return { status: 'complete', exitCode: 0 };
    }
    return { status: 'target', version: check.version };
  }
  if (check.status === 'no-target') {
    reporter.writeStdout(`No acceptable target for channel "${check.channel}" (tag unpublished, or a pre-release rejected by allowPrerelease=false) — nothing to update to.`);
    return { status: 'complete', exitCode: 0 };
  }
  if (check.status === 'up-to-date') {
    reporter.writeStdout(checkOnly ? 'No updates available.' : 'No update needed — already on latest.');
    return { status: 'complete', exitCode: 0 };
  }
  reporter.writeStderr('Update check failed. See logs above for details.');
  return { status: 'complete', exitCode: 1 };
}

export async function runManualUpdateWorkflow(
  options: ManualUpdateWorkflowOptions,
  deps: ManualUpdateDependencies = createDefaultManualUpdateDependencies(),
  reporter: ManualUpdateReporter = SILENT_REPORTER,
): Promise<ManualUpdateWorkflowOutcome> {
  const log = (message: string) => reporter.writeStdout(message);
  const error = (message: string) => reporter.writeStderr(message);
  const { config, context: updateContext } = await deps.loadState();
  const standalone = updateContext.installMode === 'npm';
  const allowPre = options.allowPrerelease === true
    ? true
    : updateContext.allowPrerelease;

  if (standalone) {
    if (options.check) {
      log('Checking NPM registry for updates...');
      const check = await deps.checkForUpdate(
        log,
        allowPre,
        updateContext.channel,
      );
      const consumed = consumeAutomaticCheck(check, true, reporter);
      return { exitCode: consumed.status === 'complete' ? consumed.exitCode : 0 };
    }

    const preflight = await deps.runPreflight(config);
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
      const gate = await deps.resolveExplicitTarget(version, allowPre);
      if (gate.status !== 'allowed') {
        error(`[dkg update] Refusing to update: ${gate.reason}.`);
        return { exitCode: 1 };
      }
      version = gate.version;
    }
    if (!version) {
      log('Checking NPM registry for updates...');
      const check = await deps.checkForUpdate(
        log,
        allowPre,
        updateContext.channel,
      );
      const consumed = consumeAutomaticCheck(check, false, reporter);
      if (consumed.status === 'complete') return { exitCode: consumed.exitCode };
      version = consumed.version;
    }

    const updateStatus = await deps.applyUpdate(config, version, log);
    if (updateStatus !== 'updated') {
      error(updateStatus === 'daemon-running'
        ? 'Update applied but old daemon is still running. Stop it manually and run "dkg start".'
        : 'Update failed. Check logs and retry.');
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
  deps?: ManualUpdateDependencies,
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
      }, deps, {
        writeStdout: runtime.writeStdout,
        writeStderr: runtime.writeStderr,
      });
      if (outcome.exitCode !== 0) runtime.setExitCode(outcome.exitCode);
    });
}
