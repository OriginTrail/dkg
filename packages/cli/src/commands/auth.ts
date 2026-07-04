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

export function registerAuthCommand(program: Command): void {
// ─── dkg auth ─────────────────────────────────────────────────────────

const authCmd = program
  .command('auth')
  .description('Manage API authentication tokens');

authCmd
  .command('show')
  .description('Display the current auth token')
  .action(async () => {
    const { loadTokens } = await import('../auth.js');
    const config = await loadConfig();
    const tokens = await loadTokens(config.auth);
    if (tokens.size === 0) {
      console.log('No auth tokens configured.');
      return;
    }
    for (const t of tokens) console.log(t);
  });

authCmd
  .command('rotate')
  .description('Generate a new auth token (replaces the file-based token)')
  .action(async () => {
    const { randomBytes } = await import('node:crypto');
    const { writeFile, chmod, mkdir } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const tokenPath = join(dkgDir(), 'auth.token');
    const token = randomBytes(32).toString('base64url');
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, `# DKG node API token — treat this like a password\n${token}\n`, { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    console.log('New token generated:');
    console.log(token);
    console.log(`\nSaved to ${tokenPath}`);
    console.log('Restart the daemon for the new token to take effect.');
  });

authCmd
  .command('status')
  .description('Show whether authentication is enabled')
  .action(async () => {
    const { readDashboardCredentialSummary } = await import('../daemon/dashboard-credentials.js');
    const config = await loadConfig();
    const enabled = config.auth?.enabled !== false;
    const dashboardCredentials = await readDashboardCredentialSummary();
    console.log(`  Authentication: ${enabled ? 'enabled' : 'disabled'}`);
    console.log(`  Token file:     ${join(dkgDir(), 'auth.token')}`);
    if (config.auth?.tokens?.length) {
      console.log(`  Config tokens:  ${config.auth.tokens.length}`);
    }
    if (dashboardCredentials.invalid) {
      console.log(`  Dashboard login: unavailable (invalid credential file)`);
      console.log(`  Dashboard file:  ${dashboardCredentials.path}`);
    } else if (dashboardCredentials.exists) {
      console.log(`  Dashboard login: configured (${dashboardCredentials.username})`);
      console.log(`  Dashboard file:  ${dashboardCredentials.path}`);
    } else {
      console.log(`  Dashboard login: not configured`);
      console.log(`  Dashboard file:  ${dashboardCredentials.path}`);
    }
  });

const dashboardAuthCmd = authCmd
  .command('dashboard')
  .description('Manage dashboard username/password login');

dashboardAuthCmd
  .command('reset-password')
  .description('Generate a new dashboard password')
  .option('--username <username>', 'Dashboard username to store')
  .action(async (opts: { username?: string }) => {
    const { resetDashboardPassword } = await import('../daemon/dashboard-credentials.js');
    const result = await resetDashboardPassword(opts.username ? { username: opts.username } : {});
    console.log('Dashboard password reset.');
    console.log(`Username: ${result.username}`);
    console.log(`Password: ${result.password}`);
    console.log(`\nCredential hash saved to ${result.path}`);
    console.log('Save this password securely. It will not be shown again.');
    console.log('Existing password-login dashboard sessions will be invalidated on their next request.');
  });
}
