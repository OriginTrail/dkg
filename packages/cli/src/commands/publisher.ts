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
import { parsePositiveIntegerOption, parsePositiveMsOption } from '../publisher-runner.js';
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

export function registerPublisherCommand(program: Command): void {
const publisherCmd = program
  .command('publisher')
  .description('Async publisher job inspection and control');

const publisherWalletCmd = publisherCmd
  .command('wallet')
  .description('Manage async publisher wallets');

publisherWalletCmd
  .command('add <private-key>')
  .description('Add a publisher wallet private key')
  .action(async (privateKey: string) => {
    try {
      const { addPublisherWallet, publisherWalletsPath } = await import('../publisher-wallets.js');
      const result = await addPublisherWallet(dkgDir(), privateKey);
      console.log('Publisher wallet added.');
      console.log(`  File:    ${publisherWalletsPath(dkgDir())}`);
      console.log(`  Wallets: ${result.wallets.length}`);
      console.log(`  Address: ${result.wallets[result.wallets.length - 1]?.address}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherWalletCmd
  .command('list')
  .description('List configured publisher wallets')
  .action(async () => {
    try {
      const { loadPublisherWallets, publisherWalletsPath } = await import('../publisher-wallets.js');
      const result = await loadPublisherWallets(dkgDir());
      console.log(`File: ${publisherWalletsPath(dkgDir())}`);
      if (result.wallets.length === 0) {
        console.log('No publisher wallets configured.');
        return;
      }
      for (const wallet of result.wallets) {
        console.log(wallet.address);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherWalletCmd
  .command('remove <address>')
  .description('Remove a publisher wallet by address')
  .action(async (address: string) => {
    try {
      const { removePublisherWallet, publisherWalletsPath } = await import('../publisher-wallets.js');
      const result = await removePublisherWallet(dkgDir(), address);
      console.log('Publisher wallet removed.');
      console.log(`  File:    ${publisherWalletsPath(dkgDir())}`);
      console.log(`  Wallets: ${result.wallets.length}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('enable')
  .description('Enable async publisher runtime')
  .option('--poll-interval <ms>', 'Poll interval in milliseconds', '12000')
  .option('--error-backoff <ms>', 'Error backoff in milliseconds', '5000')
  .option('--max-retries <count>', 'Maximum async Lift retries per job', '10')
  .action(async (opts: ActionOpts) => {
    try {
      const config = await loadConfig();
      config.publisher = {
        enabled: true,
        pollIntervalMs: parsePositiveMsOption(String(opts.pollInterval ?? '12000'), '--poll-interval'),
        errorBackoffMs: parsePositiveMsOption(String(opts.errorBackoff ?? '5000'), '--error-backoff'),
        maxRetries: parsePositiveIntegerOption(String(opts.maxRetries ?? '10'), '--max-retries'),
      };
      await saveConfig(config);
      console.log('Async publisher enabled');
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('disable')
  .description('Disable async publisher runtime')
  .action(async () => {
    try {
      const config = await loadConfig();
      config.publisher = { ...(config.publisher ?? {}), enabled: false };
      await saveConfig(config);
      console.log('Async publisher disabled');
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('publish-async <context-graph> <name>')
  .description('Enqueue a named knowledge asset VM publish job')
  .option('--sub-graph <name>', 'Target sub-graph within the context graph')
  .option('--publish-epochs <count>', 'On-chain publish lifetime in epochs (default: 12; PCA-funded publishes may coerce to PCA lock duration)')
  .action(async (contextGraph: string, name: string, opts: ActionOpts) => {
    try {
      const publishEpochs = opts.publishEpochs !== undefined
        ? parsePositiveIntegerOption(String(opts.publishEpochs), '--publish-epochs')
        : undefined;

      const client = await ApiClient.connect();
      const result = await client.knowledgeAssetPublishAsync(contextGraph, name, {
        ...(opts.subGraph ? { subGraphName: String(opts.subGraph) } : {}),
        ...(publishEpochs !== undefined ? { publishEpochs } : {}),
      });

      console.log('Knowledge asset publish job accepted:');
      console.log(`  Job ID:     ${result.jobId}`);
      console.log(`  Context:    ${contextGraph}`);
      console.log(`  Name:       ${name}`);
      console.log(`  Status:     ${result.status}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('jobs')
  .description('List async publisher jobs')
  .option('--status <value>', 'Filter by status')
  .action(async (opts: ActionOpts) => {
    try {
      const status = opts.status ? String(opts.status) : undefined;
      if (status && !['accepted', 'claimed', 'validated', 'broadcast', 'included', 'finalized', 'failed'].includes(status)) {
        console.error(`Invalid publisher job status: ${status}`);
        process.exit(1);
      }

      let jobs: any[];
      try {
        const client = await ApiClient.connect();
        const result = await client.publisherJobs(status);
        jobs = result.jobs;
      } catch (err) {
        if (!isDaemonUnreachable(err)) throw err;
        const config = await loadConfig();
        const { createPublisherInspector } = await import('../publisher-runner.js');
        const inspector = await createPublisherInspector({ dataDir: dkgDir(), config });
        try {
          jobs = await inspector.publisher.list(status ? { status: status as any } : undefined);
        } finally {
          await inspector.stop();
        }
      }
      console.log(JSON.stringify(jobs.map(formatPublisherJobOutput), null, 2));
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('job <job-id>')
  .description('Show async publisher job details')
  .option('--payload', 'Include prepared payload details')
  .action(async (jobId: string, opts: ActionOpts) => {
    try {
      let result: any;
      try {
        const client = await ApiClient.connect();
        if (opts.payload) {
          const resp = await client.publisherJobPayload(jobId);
          result = { ...resp.job, payload: resp.payload };
        } else {
          const resp = await client.publisherJob(jobId);
          result = resp.job;
        }
      } catch (err) {
        if (!isDaemonUnreachable(err)) throw err;
        const config = await loadConfig();
        const { createPublisherInspector } = await import('../publisher-runner.js');
        const inspector = await createPublisherInspector({ dataDir: dkgDir(), config });
        try {
          const job = await inspector.publisher.getStatus(jobId);
          if (!job) {
            console.error(`Publisher job not found: ${jobId}`);
            process.exit(1);
          }
          if (opts.payload) {
            const payload = await inspector.publisher.inspectPreparedPayload(jobId);
            result = { ...job, payload };
          } else {
            result = job;
          }
        } finally {
          await inspector.stop();
        }
      }
      if (!result) {
        console.error(`Publisher job not found: ${jobId}`);
        process.exit(1);
      }
      console.log(JSON.stringify(formatPublisherJobOutput(result), null, 2));
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('stats')
  .description('Show async publisher job counts by status')
  .action(async () => {
    try {
      let stats: Record<string, number>;
      try {
        const client = await ApiClient.connect();
        stats = await client.publisherStats();
      } catch (err) {
        if (!isDaemonUnreachable(err)) throw err;
        const config = await loadConfig();
        const { createPublisherInspector } = await import('../publisher-runner.js');
        const inspector = await createPublisherInspector({ dataDir: dkgDir(), config });
        try {
          stats = await inspector.publisher.getStats();
        } finally {
          await inspector.stop();
        }
      }
      console.log(JSON.stringify(stats, null, 2));
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('cancel <job-id>')
  .description('Cancel an async publisher job')
  .action(async (jobId: string) => {
    try {
      try {
        const client = await ApiClient.connect();
        await client.publisherCancel(jobId);
      } catch (err) {
        if (!isDaemonUnreachable(err)) throw err;
        const config = await loadConfig();
        const { createPublisherInspector } = await import('../publisher-runner.js');
        const inspector = await createPublisherInspector({ dataDir: dkgDir(), config });
        try {
          await inspector.publisher.cancel(jobId);
        } finally {
          await inspector.stop();
        }
      }
      console.log(`Cancelled publisher job: ${jobId}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('retry')
  .description('Retry failed async publisher jobs')
  .option('--status <value>', 'Retry filter (currently only "failed" is supported)', 'failed')
  .action(async (opts: ActionOpts) => {
    try {
      const status = String(opts.status ?? 'failed');
      if (status !== 'failed') {
        console.error(`Invalid retry status: ${status}. Only "failed" is supported.`);
        process.exit(1);
      }
      let count: number;
      try {
        const client = await ApiClient.connect();
        const result = await client.publisherRetry(status);
        count = result.retried;
      } catch (err) {
        if (!isDaemonUnreachable(err)) throw err;
        const config = await loadConfig();
        const { createPublisherInspector } = await import('../publisher-runner.js');
        const inspector = await createPublisherInspector({ dataDir: dkgDir(), config });
        try {
          count = await inspector.publisher.retry({ status: 'failed' });
        } finally {
          await inspector.stop();
        }
      }
      console.log(`Retried ${count} publisher job(s).`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('clear <status>')
  .description('Clear terminal async publisher jobs by status')
  .action(async (status: string) => {
    try {
      if (status !== 'finalized' && status !== 'failed') {
        console.error(`Invalid clear status: ${status}. Use "finalized" or "failed".`);
        process.exit(1);
      }
      let count: number;
      try {
        const client = await ApiClient.connect();
        const result = await client.publisherClear(status);
        count = result.cleared;
      } catch (err) {
        if (!isDaemonUnreachable(err)) throw err;
        const config = await loadConfig();
        const { createPublisherInspector } = await import('../publisher-runner.js');
        const inspector = await createPublisherInspector({ dataDir: dkgDir(), config });
        try {
          count = await inspector.publisher.clear(status);
        } finally {
          await inspector.stop();
        }
      }
      console.log(`Cleared ${count} publisher job(s) with status ${status}.`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

}
