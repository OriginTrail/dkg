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

export function registerIndexCommand(program: Command): void {
// ─── dkg index ──────────────────────────────────────────────────────

program
  .command('index [directory]')
  .description('Index a repository and write to shared memory or publish directly')
  .option('-p, --context-graph <id>', 'Target context graph', 'dev-coordination')
  .option('--shared-memory', 'Write indexed quads to shared memory instead of publishing')
  .option('--workspace', 'Write indexed quads to shared memory instead of publishing (legacy alias)')
  .option('--include-content', 'Index docs/content files in addition to source code')
  .option('--solidity-ast', 'Use Hardhat build-info ASTs for Solidity indexing (adds StateVariable/Event/Error/Modifier and a call-graph). Falls back to regex for packages without artifacts/build-info/.')
  .option('--dry-run', 'Print statistics without publishing')
  .option('--output <file>', 'Write quads to a JSON file instead of publishing')
  .action(async (directory: string | undefined, opts: ActionOpts) => {
    try {
      const { resolve } = await import('node:path');
      const repoRoot = resolve(directory ?? '.');
      const targetContextGraph = opts.contextGraph ?? 'dev-coordination';
      const useSharedMemory = opts.sharedMemory || opts.workspace;

      console.log(`Indexing ${repoRoot}...`);
      const { indexRepository } = await import('../indexer.js');
      const result = await indexRepository(repoRoot, {
        includeContent: Boolean(opts.includeContent),
        solidityAst: Boolean(opts.solidityAst),
        contextGraphId: targetContextGraph,
      });

      console.log(`\n  Packages:  ${result.packageCount}`);
      console.log(`  Modules:   ${result.moduleCount}`);
      console.log(`  Functions: ${result.functionCount}`);
      console.log(`  Classes:   ${result.classCount}`);
      console.log(`  Contracts: ${result.contractCount}`);
      console.log(`  Quads:     ${result.quads.length}`);

      if (opts.output) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(opts.output, JSON.stringify(result.quads, null, 2));
        console.log(`\nWritten to ${opts.output}`);
        return;
      }

      if (opts.dryRun) {
        console.log('\n  (dry run — not publishing)');
        return;
      }

      const client = await ApiClient.connect();
      // RFC-001 §9.x — both branches now go through the assertion
      // lifecycle. `--shared-memory` stages content into a named WM
      // assertion (no chain submit); the default branch publishes
      // directly via the one-shot `publishAssertion` helper.
      const indexAssertionName = `index-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const verb = useSharedMemory ? 'Staging in WM assertion' : 'Publishing';
      const applyBatch = useSharedMemory
        ? async (batch: typeof result.quads) => {
            // Create-or-append: the daemon's create endpoint is
            // idempotent on `(cg, name)`, so we lazily create on the
            // first batch (no quads body) and append on subsequent
            // batches via `/api/knowledge-assets/:name/wm/write`.
            await client.createAssertion(targetContextGraph, indexAssertionName);
            return client.appendToAssertion(
              targetContextGraph,
              indexAssertionName,
              batch,
            );
          }
        : async (batch: typeof result.quads) => client.publish(targetContextGraph, batch);

      await publishEntityBatches(result.quads, applyBatch, (sent) => {
        process.stdout.write(`\r  ${verb}: ${sent}/${result.quads.length} quads`);
      }, {
        maxBatchBytes: useSharedMemory ? 240 * 1024 : undefined,
        estimateBatchBytes: useSharedMemory
          ? (batch) => new TextEncoder().encode(JSON.stringify({ contextGraphId: targetContextGraph, quads: batch })).length
          : undefined,
        splitOversizedEntities: useSharedMemory ? true : undefined,
      });

      if (useSharedMemory) {
        console.log(`\n\n  Staged ${result.quads.length} quads into WM assertion "${indexAssertionName}" for context graph "${targetContextGraph}".`);
        console.log(`  Next: dkg assertion promote ${indexAssertionName} -c ${targetContextGraph}`);
      } else {
        console.log(`\n\n  Published ${result.quads.length} quads to context graph "${targetContextGraph}".`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

}
