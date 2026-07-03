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

export function registerPcaCommand(program: Command): void {
// ─── dkg publisher ────────────────────────────────────────────────────

// ─── dkg pca — Publishing Conviction Account management ──────────────
//
// Operator surface for standing up and inspecting on-chain PCAs. Required
// fixture for RFC §4 modes (a) and (b) of the agent-provenance runbook.
// Writes are owner-gated by the on-chain `DKGPublishingConvictionNFT`
// contract — the daemon's EOA must own the PCA NFT for `pca register-agent`,
// `pca deregister-agent` and `pca funds` to land. `pca settle` is
// permissionless; read-side (`pca info`) is permissionless.
const pcaCmd = program
  .command('pca')
  .description('Publishing Conviction Account: create, register agents, top-up, settle, inspect');

pcaCmd
  .command('create')
  .description('Create a new V10 conviction NFT. Daemon EOA becomes the owner')
  .requiredOption('--tokens <amount>', 'TRAC commitment (decimal, e.g. 100000)')
  .requiredOption('--primary-node <identityId>', 'OT-RFC-51: node identityId this PCA funds (uint72, > 0)')
  .action(async (opts: { tokens: string; primaryNode: string }) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.createPca({ tokens: opts.tokens, primaryNode: opts.primaryNode });
      console.log(`PCA created (owner = daemon EOA):`);
      console.log(`  accountId:        ${result.accountId}`);
      console.log(`  primaryNode:      ${opts.primaryNode}`);
      console.log(`  committedTokens:  ${result.committedTokens} TRAC`);
      console.log(`  txHash:           ${result.txHash}`);
      console.log(`  block:            ${result.blockNumber}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

pcaCmd
  .command('register-agent <accountId> <agent>')
  .description('Register `agent` as a conviction agent on the PCA (owner-only on chain)')
  .action(async (accountId: string, agent: string) => {
    try {
      if (!/^\d+$/.test(accountId)) {
        console.error('accountId must be a non-negative integer');
        process.exit(1);
      }
      const client = await ApiClient.connect();
      const result = await client.registerPcaAgent(accountId, agent);
      console.log(`Registered agent on PCA ${result.accountId}:`);
      console.log(`  agent:      ${result.agent}`);
      // #1346 — a mined tx is authoritative, so `registered` is true on
      // success. On-chain confirmation is a separate advisory signal; a
      // lagging read must not read as "registered: false (verified)".
      console.log(`  registered: ${result.registered}`);
      if (result.verified === true) {
        console.log(`  verified:   confirmed on-chain`);
      } else if (result.adapterSupported === false) {
        console.log(`  verified:   not verifiable on this adapter (registration is authoritative via the mined tx)`);
      } else {
        console.log(`  verified:   pending (tx mined; on-chain confirmation not yet observed — follower RPC lag)`);
      }
      console.log(`  txHash:     ${result.txHash}`);
      console.log(`  block:      ${result.blockNumber}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

pcaCmd
  .command('deregister-agent <accountId> <agent>')
  .description('Deregister `agent` from the PCA (owner-only on chain)')
  .action(async (accountId: string, agent: string) => {
    try {
      if (!/^\d+$/.test(accountId)) {
        console.error('accountId must be a non-negative integer');
        process.exit(1);
      }
      const client = await ApiClient.connect();
      const result = await client.deregisterPcaAgent(accountId, agent);
      console.log(`Deregistered agent on PCA ${result.accountId}:`);
      console.log(`  agent:        ${result.agent}`);
      console.log(`  deregistered: ${result.deregistered}`);
      console.log(`  txHash:       ${result.txHash}`);
      console.log(`  block:        ${result.blockNumber}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

pcaCmd
  .command('funds <accountId>')
  .description('Top up an existing PCA (owner-only). Approves token spend automatically')
  .requiredOption('--tokens <amount>', 'Additional TRAC to commit (decimal)')
  .action(async (accountId: string, opts: { tokens: string }) => {
    try {
      if (!/^\d+$/.test(accountId)) {
        console.error('accountId must be a non-negative integer');
        process.exit(1);
      }
      const client = await ApiClient.connect();
      const result = await client.addPcaFunds(accountId, opts.tokens);
      console.log(`PCA ${result.accountId} topped up:`);
      console.log(`  addedTokens: ${result.addedTokens} TRAC`);
      console.log(`  txHash:      ${result.txHash}`);
      console.log(`  block:       ${result.blockNumber}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

pcaCmd
  .command('settle <accountId>')
  .description('Run the lazy-settlement sweep on a PCA (permissionless on chain)')
  .action(async (accountId: string) => {
    try {
      if (!/^\d+$/.test(accountId)) {
        console.error('accountId must be a non-negative integer');
        process.exit(1);
      }
      const client = await ApiClient.connect();
      const result = await client.settlePca(accountId);
      console.log(`PCA ${result.accountId} settled:`);
      console.log(`  settled: ${result.settled}`);
      console.log(`  txHash:  ${result.txHash}`);
      console.log(`  block:   ${result.blockNumber}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

pcaCmd
  .command('info <accountId>')
  .description('Read-only PCA snapshot (owner, committedTRAC, topUpBuffer, discount). Optional `--probe-key` checks agent registration')
  .option('--probe-key <addr>', 'Also check whether <addr> is currently a registered conviction agent on the PCA')
  .action(async (accountId: string, opts: { probeKey?: string }) => {
    try {
      if (!/^\d+$/.test(accountId)) {
        console.error('accountId must be a non-negative integer');
        process.exit(1);
      }
      const client = await ApiClient.connect();
      const info = await client.getPcaInfo(accountId, opts.probeKey);
      console.log(`PCA ${info.accountId}:`);
      console.log(`  owner:            ${info.owner}`);
      console.log(`  committedTRAC:    ${info.committedTRACTrac} TRAC (${info.committedTRAC} wei)`);
      console.log(`  topUpBuffer:      ${info.topUpBufferTrac} TRAC (${info.topUpBuffer} wei)`);
      console.log(`  baseEpochAllow.:  ${info.baseEpochAllowance} wei`);
      console.log(`  createdAtEpoch:   ${info.createdAtEpoch}`);
      console.log(`  expiresAtEpoch:   ${info.expiresAtEpoch}`);
      console.log(`  agentCount:       ${info.agentCount}`);
      console.log(`  lastSettledWin.:  ${info.lastSettledWindow}`);
      console.log(`  fullySwept:       ${info.fullySwept}`);
      console.log(`  discountBps:      ${info.discountBps} (${(info.discountBps / 100).toFixed(2)}% off base cost)`);
      if (info.probedKey) {
        console.log(`  probedKey:`);
        console.log(`    key:        ${info.probedKey.key}`);
        if (info.probedKey.error) {
          console.log(`    error:      ${info.probedKey.error}`);
        } else {
          console.log(`    registered: ${info.probedKey.registered}`);
        }
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

}
