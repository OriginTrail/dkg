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

export function registerHermesCommand(program: Command): void {
// ─── dkg ccl ────────────────────────────────────────────────────────

type HermesAdapterModule = Record<string, unknown>;
type HermesAdapterAction = (opts: any) => Promise<void>;

async function importHermesAdapterModule(): Promise<HermesAdapterModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<HermesAdapterModule>;
  return dynamicImport('@origintrail-official/dkg-adapter-hermes');
}

function resolveHermesAdapterAction(
  adapter: HermesAdapterModule,
  commandName: string,
  candidates: readonly string[],
): HermesAdapterAction {
  for (const candidate of candidates) {
    const value = adapter[candidate];
    if (typeof value === 'function') return value as HermesAdapterAction;
  }
  throw new Error(`@origintrail-official/dkg-adapter-hermes does not export a ${commandName} helper yet`);
}

async function loadHermesAdapterAction(
  commandName: string,
  candidates: readonly string[],
): Promise<HermesAdapterAction> {
  let adapter: HermesAdapterModule;
  try {
    adapter = await importHermesAdapterModule();
  } catch (err: any) {
    console.error(`\n[dkg hermes ${commandName}] Hermes adapter is not available.`);
    console.error(`  Reason: ${err?.message ?? err}`);
    console.error('  In a monorepo dev checkout: run `pnpm install` and build the Hermes adapter workspace.');
    console.error('  With a global install: reinstall with Hermes adapter support included.\n');
    process.exit(1);
  }

  try {
    return resolveHermesAdapterAction(adapter, commandName, candidates);
  } catch (err: any) {
    console.error(`\n[dkg hermes ${commandName}] ${err?.message ?? err}\n`);
    process.exit(1);
  }
}

const hermesCmd = program
  .command('hermes')
  .description('Hermes adapter management');

hermesCmd
  .command('setup')
  .description('Set up DKG node + Hermes adapter (non-interactive, idempotent)')
  .option('--profile <name>', 'Hermes profile name')
  .option('--daemon-url <url>', 'DKG daemon URL')
  .option('--bridge-url <url>', 'Hermes loopback bridge URL for local same-host chat')
  .option('--gateway-url <url>', 'Hermes gateway URL for WSL2 or remote chat')
  .option('--bridge-health-url <url>', 'Hermes bridge health URL override')
  .option('--port <port>', 'Override daemon API port (default: 9200)')
  .option('--memory-mode <mode>', 'Memory mode: primary or tools-only')
  .option('--dry-run', 'Preview changes without writing anything')
  .option('--no-verify', 'Skip post-setup verification')
  .option('--no-start', 'Skip daemon start (configure only)')
  .option('--no-fund', 'Skip wallet funding via testnet faucet')
  .option('--fund', 'Fund wallets via testnet faucet (default)')
  .option(
    '--network <name>',
    'Network to set up on (mainnet-gnosis | mainnet-base | testnet). Default for a fresh node: mainnet-gnosis.',
  )
  .option(
    '--preserve-provider',
    'Refuse to replace an existing non-DKG memory.provider in the Hermes profile config (default: replace with backup)',
  )
  // Commander registers `--no-replace-provider` as the negation of an
  // implicit `--replace-provider` (default true) — the parsed key is
  // `replaceProvider`, and `--no-replace-provider` sets it to `false`.
  // We map that to the canonical `preserveProvider: true` in the action
  // handler below so the adapter sees a single normalized field.
  .option(
    '--no-replace-provider',
    'Alias for --preserve-provider',
  )
  .option(
    '--store <backend>',
    `Triple-store backend (${storeFlagBackendList(' | ')}). Validates the URL and persists the store block after setup.`,
  )
  .option(
    '--store-url <url>',
    'SPARQL endpoint URL — required when --store is blazegraph or sparql-http.',
  )
  .action(async (opts, command) => {
    const runSetup = await loadHermesAdapterAction('setup', ['runSetup', 'setup']);
    const { hermesSetupAction } = await import('../hermes-setup.js');
    try {
      // Collapse `--no-replace-provider` (commander parses as
      // `replaceProvider: false`) into the canonical `preserveProvider: true`
      // so the action handler / normalizer sees a single source of truth.
      const merged = opts.replaceProvider === false
        ? { ...opts, preserveProvider: true }
        : opts;
      await hermesSetupAction(merged, command, { runSetup });
      await applyStoreFlagsToConfig({
        storeFlag: opts.store,
        storeUrlFlag: opts.storeUrl,
      });
    } catch (err: any) {
      console.error(`\n[hermes setup] ERROR: ${err?.message ?? err}\n`);
      process.exit(1);
    }
  });

for (const [commandName, candidates, description] of [
  ['status', ['runStatus', 'status'], 'Show Hermes adapter status'],
  ['verify', ['runVerify', 'verify'], 'Verify Hermes adapter configuration'],
  ['doctor', ['runDoctor', 'doctor'], 'Diagnose Hermes adapter issues'],
  ['disconnect', ['runDisconnect', 'disconnect'], 'Disconnect this node from a Hermes profile'],
  ['reconnect', ['runReconnect', 'reconnect'], 'Reconnect this node to a Hermes profile'],
  ['uninstall', ['runUninstall', 'uninstall'], 'Uninstall the Hermes adapter wiring'],
] as const) {
  const command = hermesCmd
    .command(commandName)
    .description(description)
    .option('--profile <name>', 'Hermes profile name')
    .option('--dry-run', 'Preview changes without writing anything');
  if (commandName === 'reconnect') {
    command
      .option('--daemon-url <url>', 'DKG daemon URL')
      .option('--bridge-url <url>', 'Hermes loopback bridge URL for local same-host chat')
      .option('--gateway-url <url>', 'Hermes gateway URL for WSL2 or remote chat')
      .option('--bridge-health-url <url>', 'Hermes bridge health URL override')
      .option('--port <port>', 'Override daemon API port (default: 9200)')
      .option('--memory-mode <mode>', 'Memory mode: primary or tools-only')
      .option('--no-verify', 'Skip post-reconnect verification')
      .option('--no-start', 'Skip daemon start (configure only)');
  }
  if (commandName === 'disconnect') {
    command.option(
      '--restore-provider',
      'After disconnect, restore the prior memory.provider captured during setup (default: disconnect-only)',
    );
  }
  command.action(async (opts) => {
    const action = await loadHermesAdapterAction(commandName, candidates);
    try {
      if (commandName === 'reconnect') {
        const { loadBundledDkgNodeSkill } = await import('../hermes-setup.js');
        await action({ ...opts, nodeSkillContent: loadBundledDkgNodeSkill() });
        return;
      }
      await action(opts);
    } catch (err: any) {
      console.error(`\n[hermes ${commandName}] ERROR: ${err?.message ?? err}\n`);
      process.exit(1);
    }
  });
}

}
