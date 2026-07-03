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

export function registerKnowledgeCommands(program: Command): void {
// ─── dkg verify <batchId> ──────────────────────────────────────────

program
  .command('verify <batchId>')
  .description('Propose M-of-N verification for a published batch')
  .requiredOption('--context-graph <id>', 'Context Graph ID')
  .requiredOption('--verified-graph <id>', 'Verified Graph ID')
  .option('--timeout <ms>', `Timeout in milliseconds (default/max: ${VERIFY_COLLECTION_TIMEOUT_MAX_MS})`)
  .option('--required-signatures <n>', 'M-of-N quorum threshold (default: system parameter parametersStorage.minimumRequiredSignatures)')
  .action(async (batchId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const timeoutMs = parseOptionalVerifyTimeoutOption(opts.timeout);
      const result = await client.verify({
        contextGraphId: opts.contextGraph,
        verifiableMemoryId: opts.verifiedGraph,
        batchId,
        timeoutMs,
        requiredSignatures: opts.requiredSignatures ? Number(opts.requiredSignatures) : undefined,
      });
      if (result.status === 'verified' || result.txHash) {
        console.log(`Verified batch ${batchId} → _verifiable_memory/${result.verifiableMemoryId}`);
        console.log(`  TX: ${result.txHash}`);
        console.log(`  Block: ${result.blockNumber}`);
      } else if (result.status === 'partial') {
        console.log(`Partially verified batch ${batchId} (no chain tx)`);
        console.log(`  Trust: ${result.trustLevel}`);
      } else {
        console.log(`Verification did not reach quorum for batch ${batchId} (no chain tx)`);
        console.log(`  Trust: ${result.trustLevel ?? 'self-attested'}`);
      }
      console.log(`  Signers: ${result.signers.join(', ')}`);
    } catch (err) {
      console.error(`Verify failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── dkg endorse <ual> ─────────────────────────────────────────────

program
  .command('endorse <ual>')
  .description('Endorse a published Knowledge Asset as the authenticated agent')
  // A-12 review: the endorser is resolved from the bearer token, not
  // from a `--agent` flag (the previous behaviour let any caller with
  // node access forge endorsements under arbitrary addresses).
  // `--agent` is kept as an optional sanity check: if it is supplied
  // we assert it matches the token's agent before sending the
  // request, so a user who typo's the agent gets a local error
  // instead of a 403 round-trip. If the user wants to endorse as a
  // specific agent other than the node's default, they must
  // authenticate with that agent's token.
  .requiredOption('--context-graph <id>', 'Context Graph ID')
  .option('--agent <address>', 'Optional: assert the authenticated agent matches this address before sending')
  .action(async (ual: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const request: { contextGraphId: string; ual: string; agentAddress?: string } = {
        contextGraphId: opts.contextGraph,
        ual,
      };
      if (typeof opts.agent === 'string' && opts.agent.length > 0) {
        request.agentAddress = opts.agent;
      }
      const result = await client.endorse(
        request as { contextGraphId: string; ual: string; agentAddress: string },
      );
      console.log(`Endorsed ${ual} by ${result.endorserAddress}`);
    } catch (err) {
      console.error(`Endorse failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── dkg query <context-graph> <sparql> ─────────────────────────────

program
  .command('query [context-graph]')
  .description('Run a SPARQL query against a context graph (or all)')
  .option('-q, --sparql <query>', 'SPARQL query string')
  .option('-f, --file <path>', 'File containing SPARQL query')
  .option('--include-shared-memory', 'Include shared (unpublished) memory in the query - use for data promoted through the KA lifecycle before on-chain registration')
  .action(async (contextGraph: string | undefined, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();

      let sparql = opts.sparql;
      if (!sparql && opts.file) {
        const { readFile } = await import('node:fs/promises');
        sparql = await readFile(opts.file, 'utf-8');
      }
      if (!sparql) {
        console.error('Provide --sparql or --file');
        process.exit(1);
      }

      const { result } = await client.query(sparql, contextGraph, {
        includeSharedMemory: Boolean(opts.includeSharedMemory),
      });

      if (result?.type === 'bindings' && result.bindings) {
        const { bindings } = result;
        if (bindings.length === 0) {
          console.log('No results.');
          return;
        }
        const keys = Object.keys(bindings[0]);
        const widths = keys.map(k => Math.max(k.length, ...bindings.map(
          (row) => stripQuotes(String(row[k] ?? '')).length,
        )));

        const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
        console.log(header);
        console.log(widths.map((w: number) => '─'.repeat(w)).join('  '));
        for (const row of bindings) {
          const line = keys.map((k, i) => stripQuotes(String(row[k] ?? '')).padEnd(widths[i])).join('  ');
          console.log(line);
        }
        console.log(`\n${bindings.length} row(s)`);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg query-remote <peer> ───────────────────────────────────────

program
  .command('query-remote <peer>')
  .description('Query a remote peer\'s knowledge store')
  .option('-q, --sparql <query>', 'SPARQL query (requires --context-graph)')
  .option('--ual <ual>', 'Look up a knowledge asset by UAL')
  .option('--entity <uri>', 'Get all triples for an entity URI (requires --context-graph)')
  .option('--type <rdfType>', 'Find entities by RDF type (requires --context-graph)')
  .option('-p, --context-graph <id>', 'Target context graph')
  .option('-l, --limit <n>', 'Max results', '100')
  .option('--timeout <ms>', 'Query timeout in ms', '5000')
  .action(async (peer: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const contextGraphId = opts.contextGraph;

      let lookupType: string;
      const request: Record<string, any> = { // eslint-disable-line @typescript-eslint/no-explicit-any
        contextGraphId,
        limit: parseInt(opts.limit, 10),
        timeout: parseInt(opts.timeout, 10),
      };

      if (opts.ual) {
        lookupType = 'ENTITY_BY_UAL';
        request.ual = opts.ual;
      } else if (opts.type) {
        lookupType = 'ENTITIES_BY_TYPE';
        request.rdfType = opts.type;
        if (!contextGraphId) {
          console.error('--context-graph is required for --type queries');
          process.exit(1);
        }
      } else if (opts.entity) {
        lookupType = 'ENTITY_TRIPLES';
        request.entityUri = opts.entity;
        if (!contextGraphId) {
          console.error('--context-graph is required for --entity queries');
          process.exit(1);
        }
      } else if (opts.sparql) {
        lookupType = 'SPARQL_QUERY';
        request.sparql = opts.sparql;
        if (!contextGraphId) {
          console.error('--context-graph is required for --sparql queries');
          process.exit(1);
        }
      } else {
        console.error('Provide one of: --ual, --type, --entity, or --sparql');
        process.exit(1);
      }

      const response = await client.queryRemote(peer, { lookupType, ...request });

      if (response.status !== 'OK') {
        console.error(`Query failed: ${response.status}`);
        if (response.error) console.error(`  ${response.error}`);
        process.exit(1);
      }

      // Display results based on lookup type
      if (response.ntriples !== undefined) {
        if (response.ntriples) {
          console.log(response.ntriples);
        } else {
          console.log('No results.');
        }
      } else if (response.entityUris?.length) {
        for (const uri of response.entityUris) {
          console.log(uri);
        }
      } else if (response.bindings) {
        try {
          const bindings = JSON.parse(response.bindings);
          if (bindings.length === 0) {
            console.log('No results.');
          } else {
            const keys = Object.keys(bindings[0]);
            const rows = bindings as Array<Record<string, string>>;
            const widths = keys.map(k => Math.max(k.length, ...rows.map(
              (row) => stripQuotes(String(row[k] ?? '')).length,
            )));
            const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
            console.log(header);
            console.log(widths.map((w: number) => '─'.repeat(w)).join('  '));
            for (const row of rows) {
              const line = keys.map((k, i) => stripQuotes(String(row[k] ?? '')).padEnd(widths[i])).join('  ');
              console.log(line);
            }
            console.log(`\n${bindings.length} row(s)`);
          }
        } catch {
          console.log(response.bindings);
        }
      } else {
        console.log('No results.');
      }

      if (response.truncated) {
        console.log(`\n(results truncated — ${response.resultCount} total)`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg subscribe <context-graph> ──────────────────────────────────

program
  .command('subscribe <context-graph>')
  .description('Subscribe to a context graph\'s GossipSub topic')
  .option('--save', 'Also save to config so it auto-subscribes on restart')
  .action(async (contextGraph: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.subscribeToContextGraph(contextGraph);
      console.log(`Subscribed to context graph: ${contextGraph}`);
      const catchup = result.catchup;
      if (catchup) {
        if ('peersTried' in catchup) {
          console.log(
            `Catch-up sync: peers ${catchup.peersTried}/${catchup.syncCapablePeers} (connected ${catchup.connectedPeers}), data ${catchup.dataSynced}, shared memory ${catchup.sharedMemorySynced}`,
          );
        } else {
          console.log(
            `Catch-up sync queued in background (job ${catchup.jobId}, shared memory ${catchup.includeWorkspace ? 'enabled' : 'disabled'}).`,
          );
        }
      }

      if (opts.save) {
        const config = await loadConfig();
        const cgs = new Set(resolveContextGraphs(config));
        cgs.add(contextGraph);
        config.contextGraphs = [...cgs];
        config.contextGraphs = [...cgs];
        await saveConfig(config);
        console.log('Saved to config (will auto-subscribe on restart).');
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

}
