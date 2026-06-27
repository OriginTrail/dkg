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

export function registerSharedMemoryCommand(program: Command): void {
// ─── dkg shared-memory (alias: workspace) ───────────────────────────

const sharedMemoryCmd = program
  .command('shared-memory')
  .alias('workspace')
  .description('Shared memory operations (write-first workflow)');

sharedMemoryCmd
  .command('write [context-graph]')
  .description('Stage triples into a named WM assertion (the new home of "shared-memory write")')
  .option('-f, --file <path>', 'RDF file (.nq, .nt, .ttl, .trig, .jsonld, .json)')
  .option('--format <fmt>', 'Explicit RDF format (nquads|ntriples|turtle|trig|json|jsonld)')
  .option('-t, --triples <json>', 'Inline JSON array of {subject, predicate, object} triples')
  .option('-s, --subject <uri>', 'Subject URI for simple write')
  .option('-p, --predicate <uri>', 'Predicate URI for simple write')
  .option('-o, --object <value>', 'Object value for simple write')
  .option('--name <name>', 'Assertion name (auto-generated if omitted)')
  .option('--sub-graph-name <name>', 'Optional sub-graph name')
  .action(async (contextGraph: string | undefined, opts: ActionOpts) => {
    try {
      const targetContextGraph = contextGraph ?? 'dev-coordination';
      const client = await ApiClient.connect();
      const defaultGraph = `did:dkg:context-graph:${targetContextGraph}`;
      const quads = await loadQuadsFromInput(opts, defaultGraph);
      const assertionName =
        typeof opts.name === 'string' && opts.name.length > 0
          ? (opts.name as string)
          : `cli-write-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const subGraphOption = (opts.subGraphName as string | undefined) ?? undefined;

      // RFC-001 §9.x — the legacy `shared-memory write` was a
      // free-form append into SWM. The new lifecycle requires a named
      // assertion. We create lazily on the first batch (no quads),
      // then append batches via /api/knowledge-assets/:name/wm/write.
      await client.createAssertion(targetContextGraph, assertionName, {
        ...(subGraphOption ? { subGraphName: subGraphOption } : {}),
      });
      let totalWritten = 0;
      await publishEntityBatches(
        quads,
        async (batch) => {
          const result = await client.appendToAssertion(
            targetContextGraph,
            assertionName,
            batch,
            subGraphOption ? { subGraphName: subGraphOption } : undefined,
          );
          totalWritten += result.written;
          return result;
        },
        (sent) => {
          process.stdout.write(`\r  Writing to WM assertion: ${sent}/${quads.length} quads`);
        },
        {
          maxBatchBytes: 240 * 1024,
          estimateBatchBytes: (batch) => new TextEncoder().encode(JSON.stringify({ contextGraphId: targetContextGraph, quads: batch })).length,
          splitOversizedEntities: true,
        },
      );
      console.log();
      console.log(`Staged WM assertion for "${targetContextGraph}":`);
      console.log(`  Assertion name:  ${assertionName}`);
      console.log(`  Triples written: ${totalWritten}`);
      if (subGraphOption) {
        console.log(`  Sub-graph:       ${subGraphOption}`);
      }
      console.log(`  Next:            dkg shared-memory publish ${targetContextGraph} --name ${assertionName}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

sharedMemoryCmd
  .command('publish [context-graph]')
  .description('Finalize, promote, and publish a previously-staged WM assertion')
  .requiredOption('--name <name>', 'Assertion name (from `dkg shared-memory write --name ...`)')
  .option('--sub-graph-name <name>', 'Optional sub-graph name')
  .option('--author-agent-address <address>', 'Override author EOA (must be a registered local agent)')
  .option('--publish-epochs <count>', 'On-chain publish lifetime in epochs (default: 12; PCA-funded publishes may coerce to PCA lock duration)')
  .action(async (contextGraph: string | undefined, opts: ActionOpts) => {
    try {
      const targetContextGraph = contextGraph ?? 'dev-coordination';
      const assertionName = String(opts.name);
      const subGraphOption = (opts.subGraphName as string | undefined) ?? undefined;
      const authorAgentAddress = (opts.authorAgentAddress as string | undefined) ?? undefined;
      const publishEpochs = opts.publishEpochs !== undefined
        ? parsePositiveIntegerOption(String(opts.publishEpochs), '--publish-epochs')
        : undefined;
      const client = await ApiClient.connect();

      // RFC-001 §9.x assertion lifecycle:
      //   finalize → seal in _meta (idempotent on matching merkleRoot)
      //   promote  → SWM gossip
      //   publish  → VM via /api/knowledge-assets/:name/vm/publish
      const seal = await client.finalizeAssertion(
        targetContextGraph,
        assertionName,
        {
          ...(subGraphOption ? { subGraphName: subGraphOption } : {}),
          ...(authorAgentAddress ? { authorAgentAddress } : {}),
        },
      );
      const promoted = await client.promoteAssertion(assertionName, {
        contextGraphId: targetContextGraph,
        ...(subGraphOption ? { subGraphName: subGraphOption } : {}),
      });
      const result = await client.publishFromFinalizedAssertion(
        targetContextGraph,
        assertionName,
        (subGraphOption || publishEpochs !== undefined)
          ? {
              ...(subGraphOption ? { subGraphName: subGraphOption } : {}),
              ...(publishEpochs !== undefined ? { publishEpochs } : {}),
            }
          : undefined,
      );
      console.log(`Published WM assertion to "${targetContextGraph}":`);
      console.log(`  Assertion:    ${seal.assertionUri}`);
      console.log(`  Author:       ${seal.authorAddress}`);
      console.log(`  Merkle root:  ${seal.merkleRoot}`);
      console.log(`  Promoted:     ${promoted.promotedCount ?? promoted.count ?? 0} quads`);
      console.log(`  Status:       ${result.status}`);
      console.log(`  KC ID:        ${result.kaId}`);
      console.log(`  KAs:          ${result.kas.length}`);
      if (subGraphOption) {
        console.log(`  Sub-graph:    ${subGraphOption}`);
      }
      if (result.txHash) {
        console.log(`  TX:           ${result.txHash}`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

}
