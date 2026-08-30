import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn, execSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile, unlink, appendFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import { resolveRpcUrls } from '@origintrail-official/dkg-chain';
import {
  dkgAuthTokenPath,
  FAUCET_WALLETS_PER_REQUEST,
  getFundableWalletAddresses,
  requestFaucetFunding,
  resolveDkgConfigHome,
  toErrorMessage,
  hasErrorCode,
} from '@origintrail-official/dkg-core';
import yaml from 'js-yaml';
import {
  loadConfig, saveConfig, configExists, configPath,
  readPid, readApiPort, isProcessRunning, dkgDir, logPath, ensureDkgDir, removeApiPort,
  apiPortPath,
  loadNetworkConfig, loadResolvedNetworkConfig, loadProjectConfig, resolveAutoUpdateConfig, resolveAutoUpdateSource, resolveChainConfig,
  releasesDir, activeSlot, swapSlot,
  slotEntryPoint, isStandaloneInstall, repoDir, isDkgMonorepo,
  resolveContextGraphs, resolveNetworkDefaultContextGraphs,
  readNodeRoleFromConfigSync,
  type AutoUpdateConfig,
} from '../config.js';
import { ApiClient } from '../api-client.js';
import { parsePositiveIntegerOption, parsePositiveMsOption } from '../cli-option-parsers.js';
import { promptStoreBackend, applyStoreFlagsToConfig } from '../store-wizard.js';
import { runConfiguredSourceWorker } from '../source-worker-runner.js';
import { batchEntityQuads } from '../batching.js';
import {
  runDaemon,
  checkForNpmVersionUpdate,
  resolveExplicitNpmUpdateTarget,
  performNpmUpdate,
  performNpmUpdateEdge,
  getCurrentCliVersion,
  DAEMON_EXIT_CODE_RESTART,
  resolveStandaloneInstall,
  decodeForcedExitCode,
} from '../daemon.js';
import {
  isLivenessProbeEnabled,
  startLivenessWatcher,
  LIVENESS_CONSECUTIVE_FAILURES_TO_KILL,
} from '../daemon/supervisor-liveness.js';
import { migrateToBlueGreen, noteEdgeLegacyReleases } from '../migration.js';
import { ensureRollbackNodeUiBundle } from '../rollback-node-ui.js';
import {
  isDaemonUnreachable,
  cliSleep,
  cliErrorMessage,
  STARTUP_BANNER,
  normalizeVersionTagRef,
  getCliVersion,
  parseOptionalVerifyTimeoutOption,
  loadStructuredFile,
  loadQuadsFromInput,
  resolveDaemonEntryPoint,
  probeHostForApiHost,
  selectedDkgHomeForEnv,
  withSelectedDkgHome,
  VERIFY_COLLECTION_TIMEOUT_MIN_MS,
  VERIFY_COLLECTION_TIMEOUT_MAX_MS,
  printCatchupStatus,
  runCatchupStatusCommand,
  printMessage,
  shortId,
  formatUptime,
  publishEntityBatches,
  formatPublisherJobOutput,
  formatPublisherJobValue,
  stripQuotes,
  formatQuadObject,
  sleep,
  stopDaemonIfRunning,
} from '../cli-helpers.js';
import type { ActionOpts, CatchupStatusCommandOptions } from '../cli-helpers.js';
import {
  cliWithTimeout,
  isCliKnownTransactionError,
  isCliRetryableRpcError,
  createCliEvmProviders,
  sendCliRawTransactionWithFailover,
  CLI_RPC_READ_STALL_TIMEOUT_MS,
  CLI_RPC_BROADCAST_TIMEOUT_MS,
} from '../cli-rpc.js';
import {
  appendSupervisorLog,
  supervisorWarn,
  maybeStartSupervisorLivenessWatcher,
  runDaemonSupervisor,
  runForegroundSupervisor,
} from '../cli-supervisor.js';

export type MaintenanceUpdatePreflightResult =
  | { status: 'ok'; warnings?: string[] }
  | {
    status: 'blocked';
    findings: Array<{ check: string; message: string; advisory?: string }>;
  };

export type MaintenanceUpdateWorkflowDeps = {
  loadConfig: typeof loadConfig;
  loadNetworkConfig: typeof loadNetworkConfig;
  loadResolvedNetworkConfig: typeof loadResolvedNetworkConfig;
  loadProjectConfig: typeof loadProjectConfig;
  resolveAutoUpdateConfig: typeof resolveAutoUpdateConfig;
  resolveAutoUpdateSource: typeof resolveAutoUpdateSource;
  resolveStandaloneInstall: typeof resolveStandaloneInstall;
  resolveExplicitNpmUpdateTarget: typeof resolveExplicitNpmUpdateTarget;
  checkForNpmVersionUpdate: typeof checkForNpmVersionUpdate;
  performNpmUpdate: typeof performNpmUpdate;
  performNpmUpdateEdge: typeof performNpmUpdateEdge;
  getCurrentCliVersion: typeof getCurrentCliVersion;
  stopDaemonIfRunning: typeof stopDaemonIfRunning;
  runPreflight: (
    config: Awaited<ReturnType<typeof loadConfig>>,
  ) => Promise<MaintenanceUpdatePreflightResult>;
};

export type MaintenanceUpdateWorkflowOptions = {
  versionOrRef?: string;
  check?: boolean;
  allowPrerelease?: boolean;
};

export type MaintenanceUpdateWorkflowOutcome = {
  exitCode: 0 | 1 | 2;
  stdout: string[];
  stderr: string[];
};

async function runDefaultUpdatePreflight(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<MaintenanceUpdatePreflightResult> {
  try {
    const { createProductionDeps, runDoctor, UPDATE_PREFLIGHT_CHECKS } =
      await import('../doctor/index.js');
    const preflightDeps = createProductionDeps({ apiPort: config.apiPort ?? 9200 });
    const preflight = await runDoctor(preflightDeps, { checks: UPDATE_PREFLIGHT_CHECKS });
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

function createMaintenanceUpdateWorkflowDeps(): MaintenanceUpdateWorkflowDeps {
  return {
    loadConfig,
    loadNetworkConfig,
    loadResolvedNetworkConfig,
    loadProjectConfig,
    resolveAutoUpdateConfig,
    resolveAutoUpdateSource,
    resolveStandaloneInstall,
    resolveExplicitNpmUpdateTarget,
    checkForNpmVersionUpdate,
    performNpmUpdate,
    performNpmUpdateEdge,
    getCurrentCliVersion,
    stopDaemonIfRunning,
    runPreflight: runDefaultUpdatePreflight,
  };
}

export async function runMaintenanceUpdateWorkflow(
  options: MaintenanceUpdateWorkflowOptions,
  deps: MaintenanceUpdateWorkflowDeps = createMaintenanceUpdateWorkflowDeps(),
): Promise<MaintenanceUpdateWorkflowOutcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = (message: string) => stdout.push(message);
  const error = (message: string) => stderr.push(message);
  const config = await deps.loadConfig();
  const { network: net } = await deps.loadResolvedNetworkConfig(
    config,
    deps.loadNetworkConfig,
  );
  // Resolve field-by-field across local/network/project so defaults flow
  // through even when the local config omits repo/branch.
  const au = deps.resolveAutoUpdateConfig(config, net) ?? (() => {
    const proj = deps.loadProjectConfig();
    return {
      // Mirror resolveAutoUpdateConfig precedence for the fields a manual
      // `dkg update` depends on — auto-apply being disabled must NOT drop the
      // operator's stable-only (allowPrerelease) intent or channel pin.
      enabled: true,
      repo: proj.repo,
      branch: proj.defaultBranch,
      allowPrerelease: config.autoUpdate?.allowPrerelease ?? net?.autoUpdate?.allowPrerelease ?? true,
      checkIntervalMinutes: 30,
      channel: config.autoUpdate?.channel ?? net?.autoUpdate?.channel,
      source: undefined as 'auto' | 'npm' | 'git' | undefined,
    };
  })();
  // Honour `autoUpdate.source` override so `dkg update` from a beacon-01
  // operator with `source: "npm"` configured goes through the npm install
  // path even if .git is still present in the working tree.
  const standalone = deps.resolveStandaloneInstall(
    au.source ?? deps.resolveAutoUpdateSource(config, net),
  );
  const allowPre = options.allowPrerelease === true ? true : (au.allowPrerelease ?? true);

  if (standalone) {
    if (options.check) {
      log('Checking NPM registry for updates...');
      const check = await deps.checkForNpmVersionUpdate(log, allowPre, au.channel);
      if (check.status === 'available' && check.version) {
        log(`Update available: ${check.version}`);
      } else if (check.status === 'no-target') {
        log(`No acceptable target for channel "${check.channel}" (tag unpublished, or a pre-release rejected by allowPrerelease=false) — nothing to update to.`);
      } else if (check.status === 'up-to-date') {
        log('No updates available.');
      } else {
        error('Update check failed. See logs above for details.');
        return { exitCode: 1, stdout, stderr };
      }
      return { exitCode: 0, stdout, stderr };
    }

    // RFC-41 §4.7.7 invocation pattern #3: before applying an update,
    // `dkg update` MUST run the install-layout + version-skew doctor checks.
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
      return { exitCode: 2, stdout, stderr };
    }

    let version = options.versionOrRef ?? null;
    if (version) {
      version = version.replace(/^refs\/tags\/v?/, '').replace(/^v/, '');
    }
    // An EXPLICIT target (version or dist-tag) must still honour the
    // stable-only policy.
    if (version) {
      const gate = await deps.resolveExplicitNpmUpdateTarget(version, allowPre, log);
      if (gate.status !== 'allowed') {
        error(`[dkg update] Refusing to update: ${gate.reason}.`);
        return { exitCode: 1, stdout, stderr };
      }
      // Dist-tags are mutable. Install the exact version that passed policy.
      version = gate.version;
    }
    if (!version) {
      log('Checking NPM registry for updates...');
      const check = await deps.checkForNpmVersionUpdate(log, allowPre, au.channel);
      if (check.status === 'available' && check.version) {
        version = check.version;
      } else if (check.status === 'no-target') {
        log(`No acceptable target for channel "${check.channel}" (tag unpublished, or a pre-release rejected by allowPrerelease=false) — nothing to update to.`);
        return { exitCode: 0, stdout, stderr };
      } else if (check.status === 'up-to-date') {
        log('No update needed — already on latest.');
        return { exitCode: 0, stdout, stderr };
      } else {
        error('Update check failed. See logs above for details.');
        return { exitCode: 1, stdout, stderr };
      }
    }

    const npmUpdateRole = config.nodeRole ?? 'edge';
    log(
      `Updating to ${version} via NPM ` +
        `(${npmUpdateRole === 'edge' ? 'global npm install' : 'blue-green slot'})...`,
    );
    const updateStatus = npmUpdateRole === 'edge'
      ? await deps.performNpmUpdateEdge(version, deps.getCurrentCliVersion(), log)
      : await deps.performNpmUpdate(version, log);
    if (updateStatus !== 'updated') {
      error('Update failed. Check logs and retry.');
      return { exitCode: 1, stdout, stderr };
    }
    const stopped = await deps.stopDaemonIfRunning();
    if (!stopped) {
      error('Update applied but old daemon is still running. Stop it manually and run "dkg start".');
      return { exitCode: 1, stdout, stderr };
    }
    log('Update applied. Run "dkg start" to start with the new version.');
    return { exitCode: 0, stdout, stderr };
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
  return { exitCode: 1, stdout, stderr };
}

export function registerUpdateCommand(
  program: Command,
  deps?: MaintenanceUpdateWorkflowDeps,
): void {
// ─── dkg update ──────────────────────────────────────────────────────
//
// OT-RFC-41 §4.5 / §5 PR 6: `dkg migrate-to-npm` was removed.
// Edge nodes coming from a pre-rc.12 install are migrated
// automatically on first `dkg start` via `noteEdgeLegacyReleases`
// (see migration.ts + cli.ts dkg start). Core node operators
// who still hold a git-checkout install follow the manual
// procedure documented in `docs/use-dkg/migrate-to-npm.md`.


program
  .command('update [versionOrRef]')
  .description('Check for and apply DKG node updates (blue-green swap)')
  .option('--check', 'Only check for updates, do not apply')
  .option('--allow-prerelease', 'Allow pre-release target versions')
  .option('--no-verify-tag', 'Skip signed-tag verification for version/tag updates')
  .action(async (versionOrRef: string | undefined, opts: ActionOpts) => {
    const outcome = await runMaintenanceUpdateWorkflow({
      versionOrRef,
      check: opts.check,
      allowPrerelease: opts.allowPrerelease,
    }, deps);
    for (const message of outcome.stdout) console.log(message);
    for (const message of outcome.stderr) console.error(message);
    if (outcome.exitCode !== 0) process.exit(outcome.exitCode);
  });
}

export function registerMaintenanceCommands(program: Command): void {
  registerUpdateCommand(program);

// ─── dkg rollback ────────────────────────────────────────────────────

program
  .command('rollback')
  .description('Roll back to the previous DKG version (Edge: npm reinstall; Core: blue-green slot flip)')
  .action(async () => {
    // OT-RFC-41 §4.8 / Bundle B1b: Edge rollback is a pure
    // `npm install -g @<previous>` against the npm-global install.
    // The previous version is recorded in `~/.dkg/previous-version`
    // by `performNpmUpdateEdge` (and by `noteEdgeLegacyReleases` on
    // first-start under rc.12 for users coming from a slot-based
    // install). Core continues to use the slot-flip mechanism.
    const rollbackConfig = await loadConfig().catch(() => null);
    const rollbackRole = rollbackConfig?.nodeRole ?? 'edge';

    if (rollbackRole === 'edge') {
      const previousVersionPath = join(dkgDir(), 'previous-version');
      if (!existsSync(previousVersionPath)) {
        console.error(
          "No rollback target recorded. ~/.dkg/previous-version is absent — either this is the first install, or a previous 'dkg update' did not record a target.\n",
        );
        console.error(
          'To roll back manually, run:\n' +
            `  npm install -g @origintrail-official/dkg@<version>\n\n` +
            'See https://www.npmjs.com/package/@origintrail-official/dkg?activeTab=versions for available versions.',
        );
        process.exit(1);
      }
      const targetVersion = readFileSync(previousVersionPath, 'utf-8').trim();
      if (!targetVersion) {
        console.error('~/.dkg/previous-version is empty; cannot determine rollback target.');
        process.exit(1);
      }

      const currentVersion = getCurrentCliVersion();
      console.log(`Rolling back from ${currentVersion} to ${targetVersion} via NPM...`);
      const rollbackStatus = await performNpmUpdateEdge(
        targetVersion,
        currentVersion,
        (msg) => console.log(msg),
      );
      if (rollbackStatus !== 'updated') {
        console.error('Rollback failed. Check logs and retry.');
        process.exit(1);
      }
      const stopped = await stopDaemonIfRunning();
      if (!stopped) {
        console.error('Rollback applied but old daemon is still running. Stop it manually and run "dkg start".');
        process.exit(1);
      }
      console.log(`Rolled back to ${targetVersion}. Run "dkg start" to start with the rolled-back version.`);
      return;
    }

    // Core path: existing slot-flip rollback (unchanged).
    const current = await activeSlot();
    if (!current) {
      console.error('Blue-green slots not initialized. Nothing to roll back.');
      process.exit(1);
    }

    const target = current === 'a' ? 'b' : 'a';
    const targetDir = join(releasesDir(), target);
    if (!existsSync(targetDir)) {
      console.error(`Slot ${target} does not exist. Cannot roll back.`);
      process.exit(1);
    }
    const targetEntry = slotEntryPoint(targetDir);
    if (!targetEntry) {
      console.error(`Slot ${target} has no build output. Run "dkg update" first to prepare it.`);
      process.exit(1);
    }
    if (!ensureRollbackNodeUiBundle(targetDir, target)) {
      process.exit(1);
    }

    const pid = await readPid();
    if (pid && isProcessRunning(pid)) {
      console.log('Stopping daemon...');
      try {
        process.kill(pid, 'SIGTERM');
      } catch (err) {
        if (!hasErrorCode(err, 'ESRCH')) throw err;
      }
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (!isProcessRunning(pid)) break;
      }
      if (isProcessRunning(pid)) {
        console.error('Rollback aborted: daemon is still running after SIGTERM. Stop it manually and retry.');
        process.exit(1);
      }
    }

    await swapSlot(target);
    const commitFile = join(dkgDir(), '.current-commit');
    const versionFile = join(dkgDir(), '.current-version');
    if (existsSync(join(targetDir, '.git'))) {
      try {
        const commit = execSync('git rev-parse HEAD', {
          cwd: targetDir,
          encoding: 'utf-8',
          stdio: 'pipe',
        }).trim();
        await writeFile(commitFile, commit);
      } catch (err) {
        console.warn(`Warning: failed to read rollback commit: ${toErrorMessage(err)}`);
      }
    } else {
      try { await unlink(commitFile); } catch { /* already absent */ }
    }
    try {
      // Try git layout first, then NPM layout for version metadata.
      const candidates = [
        join(targetDir, 'packages', 'cli', 'package.json'),
        join(targetDir, 'node_modules', '@origintrail-official', 'dkg', 'package.json'),
      ];
      for (const pkgPath of candidates) {
        try {
          const pkgRaw = readFileSync(pkgPath, 'utf-8');
          const version = String((JSON.parse(pkgRaw) as { version?: string }).version ?? '').trim();
          if (version) { await writeFile(versionFile, version); break; }
        } catch { /* try next */ }
      }
    } catch (err) {
      console.warn(`Warning: failed to update rollback version metadata: ${toErrorMessage(err)}`);
    }
    console.log(`Rolled back: current → slot ${target}`);
    console.log('Daemon stopped. Run "dkg start" to start with the rolled-back version.');
  });

// ─── dkg doctor ──────────────────────────────────────────────────────
//
// Per OT-RFC-41 §4.7. Surfaces install-layout / version-skew / orphan-clone
// anomalies before an agent touches DKG state. Wired into SKILL.md as a
// session-start ritual; also invoked by `dkg update`'s pre-flight check
// (the orchestrator runs a narrow subset — install-layout + version-skew).

program
  .command('doctor')
  .description('Diagnose install state, version skew, orphan clones, plugin root, and config sanity')
  .option('--json', 'Emit the report as JSON instead of human-readable text')
  .option('--no-orphan-scan', "Skip the orphan-repository home-directory scan (§4.7.1)")
  .action(async (opts: { json?: boolean; orphanScan?: boolean }) => {
    const { createProductionDeps, runDoctor, formatDoctorReport, ALL_CHECK_IDS } =
      await import('../doctor/index.js');
    const config = await loadConfig();
    const deps = createProductionDeps({ apiPort: config.apiPort ?? 9200 });
    // Overlay operator-configured scan roots + skipChecks from config.
    // The doctor namespace is opt-in — absent config means defaults.
    const doctorConfig = (config as unknown as Record<string, unknown>).doctor as
      | { scanRoots?: unknown; skipChecks?: unknown }
      | undefined;
    if (doctorConfig) {
      if (Array.isArray(doctorConfig.scanRoots)) {
        deps.extraScanRoots = doctorConfig.scanRoots.filter((s): s is string => typeof s === 'string');
      }
      if (Array.isArray(doctorConfig.skipChecks)) {
        deps.skipChecks = doctorConfig.skipChecks.filter((s): s is string => typeof s === 'string');
      }
    }
    const requestedChecks = opts.orphanScan === false
      ? ALL_CHECK_IDS.filter((id) => id !== 'orphan-repos')
      : ALL_CHECK_IDS;
    const report = await runDoctor(deps, { checks: requestedChecks });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctorReport(report));
    }
    process.exit(report.exitCode);
  });

}
