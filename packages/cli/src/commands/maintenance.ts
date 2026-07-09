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
  loadNetworkConfig, loadProjectConfig, resolveAutoUpdateConfig, resolveAutoUpdateSource, resolveChainConfig,
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
  getCliReceiptWithFailover,
  assertCliSuccessfulReceipt,
  sendCliRawTransactionWithFailover,
  CLI_RPC_READ_STALL_TIMEOUT_MS,
  CLI_RPC_BROADCAST_TIMEOUT_MS,
  CLI_RPC_RECEIPT_ATTEMPT_TIMEOUT_MS,
  CLI_RPC_RECEIPT_POLL_INTERVAL_MS,
  CLI_RPC_RECEIPT_TIMEOUT_MS,
} from '../cli-rpc.js';
import {
  appendSupervisorLog,
  supervisorWarn,
  maybeStartSupervisorLivenessWatcher,
  runDaemonSupervisor,
  runForegroundSupervisor,
} from '../cli-supervisor.js';

export function registerMaintenanceCommands(program: Command): void {
// ─── dkg update ──────────────────────────────────────────────────────
//
// OT-RFC-41 §4.5 / §5 PR 6: `dkg migrate-to-npm` was removed.
// Edge nodes coming from a pre-rc.12 install are migrated
// automatically on first `dkg start` via `noteEdgeLegacyReleases`
// (see migration.ts + cli.ts dkg start). Core node operators
// who still hold a git-checkout install follow the manual
// procedure documented in `docs/archive/MIGRATE_TO_NPM.md`
// (formerly `docs/operator/MIGRATE_TO_NPM.md`).


program
  .command('update [versionOrRef]')
  .description('Check for and apply DKG node updates (blue-green swap)')
  .option('--check', 'Only check for updates, do not apply')
  .option('--allow-prerelease', 'Allow pre-release target versions')
  .option('--no-verify-tag', 'Skip signed-tag verification for version/tag updates')
  .action(async (versionOrRef: string | undefined, opts: ActionOpts) => {
    const config = await loadConfig();
    const net = await loadNetworkConfig(config.networkConfig);
    // Resolve field-by-field across local/network/project so defaults flow
    // through even when the local config omits repo/branch.
    const au = resolveAutoUpdateConfig(config, net) ?? (() => {
      const proj = loadProjectConfig();
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
    // path even if .git is still present in the working tree. See
    // `AutoUpdateConfig.source` (config.ts) for the rationale.
    const standalone = resolveStandaloneInstall(au.source ?? resolveAutoUpdateSource(config, net));
    const allowPre = opts.allowPrerelease === true ? true : (au.allowPrerelease ?? true);

    if (standalone) {
      const logFn = (msg: string) => console.log(msg);

      if (opts.check) {
        console.log('Checking NPM registry for updates...');
        const check = await checkForNpmVersionUpdate(logFn, allowPre, au.channel);
        if (check.status === 'available' && check.version) {
          console.log(`Update available: ${check.version}`);
        } else if (check.status === 'no-target') {
          console.log(`No acceptable target for channel "${check.channel}" (tag unpublished, or a pre-release rejected by allowPrerelease=false) — nothing to update to.`);
        } else if (check.status === 'up-to-date') {
          console.log('No updates available.');
        } else {
          console.error('Update check failed. See logs above for details.');
          process.exit(1);
        }
        return;
      }

      // RFC-41 §4.7.7 invocation pattern #3: before applying an update,
      // `dkg update` MUST run the install-layout + version-skew doctor
      // checks. If either reports an `error`, abort with a pointer at
      // `dkg doctor --json` for full context. Warnings do not block.
      try {
        const { createProductionDeps, runDoctor, UPDATE_PREFLIGHT_CHECKS } =
          await import('../doctor/index.js');
        const preflightDeps = createProductionDeps({ apiPort: config.apiPort ?? 9200 });
        const preflight = await runDoctor(preflightDeps, { checks: UPDATE_PREFLIGHT_CHECKS });
        if (preflight.exitCode === 2) {
          const errors = preflight.findings.filter((f) => f.severity === 'error');
          console.error('\n[dkg update] Pre-flight checks failed; refusing to apply update.\n');
          for (const f of errors) {
            console.error(`  • [${f.check}] ${f.message}`);
            if (f.advisory) console.error(`      → ${f.advisory}`);
          }
          console.error('\nRun `dkg doctor --json` for the full diagnostic report.\n');
          process.exit(2);
        }
      } catch (err: any) {
        // Pre-flight crashing should not block updates — fall through
        // and let the real update path do its thing. Warn loudly so a
        // recurring failure is visible.
        process.stderr.write(`[dkg update] WARNING: pre-flight doctor check crashed (${err?.message ?? err}); continuing without it.\n`);
      }

      let version = versionOrRef ?? null;
      if (version) {
        version = version.replace(/^refs\/tags\/v?/, '').replace(/^v/, '');
      }
      if (!version) {
        console.log('Checking NPM registry for updates...');
        const check = await checkForNpmVersionUpdate(logFn, allowPre, au.channel);
        if (check.status === 'available' && check.version) {
          version = check.version;
        } else if (check.status === 'no-target') {
          console.log(`No acceptable target for channel "${check.channel}" (tag unpublished, or a pre-release rejected by allowPrerelease=false) — nothing to update to.`);
          return;
        } else if (check.status === 'up-to-date') {
          console.log('No update needed — already on latest.');
          return;
        } else {
          console.error('Update check failed. See logs above for details.');
          process.exit(1);
        }
      }

      // OT-RFC-41 Bundle B1b: dispatch on nodeRole. Edge runs
      // `npm install -g` against the global install (no slots);
      // Core continues to use the slot-based update path.
      const npmUpdateRole = config.nodeRole ?? 'edge';
      console.log(
        `Updating to ${version} via NPM ` +
          `(${npmUpdateRole === 'edge' ? 'global npm install' : 'blue-green slot'})...`,
      );
      const updateStatus = npmUpdateRole === 'edge'
        ? await performNpmUpdateEdge(version!, getCurrentCliVersion(), logFn)
        : await performNpmUpdate(version!, logFn);
      if (updateStatus === 'updated') {
        const stopped = await stopDaemonIfRunning();
        if (!stopped) {
          console.error('Update applied but old daemon is still running. Stop it manually and run "dkg start".');
          process.exit(1);
        }
        console.log('Update applied. Run "dkg start" to start with the new version.');
      } else {
        console.error('Update failed. Check logs and retry.');
        process.exit(1);
      }
      return;
    }

    // --- Manual git update path: hard refusal. Git source updates are daemon-only. ---
    //
    // The npm path above is the canonical manual update mechanism for both Edge
    // (`npm install -g`) and Core (`npm install` into a slot). Core nodes that
    // opt into `autoUpdate.source = "git"` run the build-from-source updater
    // only from daemon polling, so the supervised restart flow owns activation.
    //
    // For monorepo contributors: the canonical "update" is
    // `git pull && pnpm install && pnpm build` from the repo
    // root — `dkg update` is not the right tool.
    // For pre-rc.12 `install.sh` operators: re-install via
    // `npm install -g @origintrail-official/dkg` and let the
    // first-start migration record `~/.dkg/previous-version`.
    //
    console.error(
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
      '  RFC: https://github.com/OriginTrail/dkgv10-spec/blob/main/rfcs/OT-RFC-41-edge-node-npm-only-install-and-update.md\n' +
      '\n',
    );
    process.exit(1);
  });

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
