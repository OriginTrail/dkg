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
  resolveChainConfig,
  releasesDir, activeSlot, swapSlot,
  slotEntryPoint, isStandaloneInstall, repoDir, isDkgMonorepo,
  resolveContextGraphs, resolveNetworkDefaultContextGraphs,
  readNodeRoleFromConfigSync,
} from '../config.js';
import { ApiClient } from '../api-client.js';
import { parsePositiveIntegerOption, parsePositiveMsOption } from '../cli-option-parsers.js';
import { promptStoreBackend, applyStoreFlagsToConfig } from '../store-wizard.js';
import { runConfiguredSourceWorker } from '../source-worker-runner.js';
import { batchEntityQuads } from '../batching.js';
import {
  runDaemon,
  performNpmUpdateEdge,
  getCurrentCliVersion,
  DAEMON_EXIT_CODE_RESTART,
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
import type { CatchupStatusCommandOptions } from '../cli-helpers.js';
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
import { registerUpdateCommand } from './update.js';

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
