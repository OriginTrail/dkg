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
import { storeFlagBackendList } from '../store-backends.js';
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

export function registerOpenclawCommand(program: Command): void {
// ─── dkg openclaw ───────────────────────────────────────────────────

const openclawCmd = program
  .command('openclaw')
  .description('OpenClaw adapter management');

openclawCmd
  .command('setup')
  .description('Set up DKG node + OpenClaw adapter (non-interactive, idempotent)')
  .option('--workspace <dir>', 'Override OpenClaw workspace directory')
  .option('--name <name>', 'Override agent name')
  .option('--port <port>', 'Override daemon API port (default: 9200)')
  .option('--no-verify', 'Skip post-setup verification')
  .option('--no-start', 'Skip daemon start (configure only)')
  .option('--dry-run', 'Preview changes without writing anything')
  .option('--no-fund', 'Skip wallet funding via testnet faucet')
  .option('--fund', 'Fund wallets via testnet faucet (default)')
  .option(
    '--network <name>',
    'Network to set up on (mainnet-gnosis | mainnet-base | testnet). Default for a fresh node: mainnet-gnosis.',
  )
  .option(
    '--store <backend>',
    `Triple-store backend (${storeFlagBackendList(' | ')}). Validates the URL via an ASK probe and persists the store block after setup completes.`,
  )
  .option(
    '--store-url <url>',
    'SPARQL endpoint URL — required when --store is blazegraph or sparql-http.',
  )
  .action(async (opts, command) => {
    // Dynamic import + process.exit plumbing stay here; the actual `runSetup`
    // call lives in `openclawSetupAction` so it can be unit-tested without
    // spawning the built CLI.
    let runSetup: typeof import('@origintrail-official/dkg-adapter-openclaw').runSetup;
    try {
      ({ runSetup } = await import('@origintrail-official/dkg-adapter-openclaw'));
    } catch (err: any) {
      console.error('\n[dkg openclaw setup] OpenClaw adapter is not available.');
      console.error(`  Reason: ${err?.message ?? err}`);
      console.error('  • In a monorepo dev checkout: run `pnpm build` at the repo root to build all workspaces.');
      console.error('  • With a global install: reinstall with `npm install -g @origintrail-official/dkg`.\n');
      process.exit(1);
    }

    const { openclawSetupAction } = await import('../openclaw-setup.js');
    try {
      await openclawSetupAction(opts, command, { runSetup });
      // Persist --store / --store-url after the action's ensureDkgNodeConfig
      // has run; otherwise the config file may not exist yet on a fresh
      // install. Validation hits the same boot-time probe used by the
      // daemon, so an invalid URL fails here, not on the next dkg start.
      await applyStoreFlagsToConfig({
        storeFlag: opts.store,
        storeUrlFlag: opts.storeUrl,
      });
    } catch (err: any) {
      console.error(`\n[setup] ERROR: ${err?.message ?? err}\n`);
      process.exit(1);
    }
  });

}
