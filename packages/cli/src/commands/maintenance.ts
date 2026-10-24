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
} from '@origintrail-official/dkg-core';
import yaml from 'js-yaml';
import {
  loadConfig, saveConfig, configExists, configPath,
  readApiPort, dkgDir, logPath, ensureDkgDir, removeApiPort,
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
import {
  checkRollbackStores,
  prepareRollbackStores,
  readSlotVersion,
  type PreparedRollbackStores,
} from '../update/rollback-stores.js';

export interface RollbackActivationDependencies {
  stopDaemon(): Promise<boolean>;
  /** Ready the stores for the target version; null stops the rollback. */
  prepareStores(): Promise<PreparedRollbackStores | null>;
  error(message: string): void;
}

/**
 * Executable command boundary for both roles: activation is forbidden until
 * shutdown succeeds and the stores are ready for the target, and the stores
 * stay held until the activation ends. Null when the rollback stopped first.
 */
export async function executeRollbackActivation<T>(
  activate: () => Promise<T>,
  dependencies: RollbackActivationDependencies,
): Promise<{ readonly result: T } | null> {
  if (!await dependencies.stopDaemon()) {
    dependencies.error(
      'Rollback aborted because the daemon did not stop before its configured shutdown deadline.',
    );
    return null;
  }
  const stores = await dependencies.prepareStores();
  if (stores === null) return null;
  try {
    return { result: await activate() };
  } finally {
    stores.release();
  }
}

export function registerMaintenanceCommands(program: Command): void {
  registerUpdateCommand(program);

// ─── dkg rollback ────────────────────────────────────────────────────

program
  .command('rollback')
  .description('Roll back to the previous DKG version (Edge: npm reinstall; Core: blue-green slot flip)')
  .option(
    '--stores-for <version>',
    'Only ready the stopped node\'s local stores for <version>, without switching versions',
  )
  .action(async (opts: { storesFor?: string }) => {
    const currentVersion = getCurrentCliVersion();
    if (opts.storesFor !== undefined) {
      const stores = await prepareRollbackStores(
        dkgDir(), opts.storesFor, currentVersion, undefined, 'Nothing was changed.',
      );
      if (!stores) process.exit(1);
      stores.release();
      console.log(`Local stores are ready for ${opts.storesFor}.`);
      return;
    }

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

      // An Edge activates the rollback target by reinstalling it, with the
      // stores readied and held through the reinstall.
      if (!checkRollbackStores(dkgDir(), targetVersion, currentVersion)) process.exit(1);
      const activation = await executeRollbackActivation(() => {
        console.log(`Rolling back from ${currentVersion} to ${targetVersion} via NPM...`);
        return performNpmUpdateEdge(targetVersion, currentVersion, (msg) => console.log(msg));
      }, {
        stopDaemon: stopDaemonIfRunning,
        prepareStores: () => prepareRollbackStores(dkgDir(), targetVersion, currentVersion),
        error: (message) => console.error(message),
      });
      if (!activation) process.exit(1);
      if (activation.result !== 'updated') {
        console.error(
          `Rollback failed. Check logs and retry. The daemon is stopped: run "dkg start" to start ${currentVersion} again.`,
        );
        process.exit(1);
      }
      console.log(`Rolled back to ${targetVersion}. Run "dkg start" to start with the rolled-back version.`);
      return;
    }

    // Core path: blue-green slot flip.
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

    const targetVersion = readSlotVersion(targetDir);
    if (!checkRollbackStores(dkgDir(), targetVersion, currentVersion)) process.exit(1);
    // A Core activates the rollback target by switching its blue-green slot.
    if (!await executeRollbackActivation(() => swapSlot(target), {
      stopDaemon: stopDaemonIfRunning,
      prepareStores: () => prepareRollbackStores(dkgDir(), targetVersion, currentVersion),
      error: (message) => console.error(message),
    })) {
      process.exit(1);
    }
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
      if (targetVersion) await writeFile(versionFile, targetVersion);
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
