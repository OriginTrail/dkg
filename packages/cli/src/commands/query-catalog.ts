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

export function registerQueryCatalogCommand(program: Command): void {
type QueryCatalogItem = {
  slug: string;
  name: string;
  description?: string;
  sparql: string;
  resultColumn?: string;
  rank: number;
  catalogSlug: string;
  catalogName: string;
  catalogDescription?: string;
  catalogRank: number;
  subGraph: string;
};

const CONTEXT_GRAPH_QUERY_SUBGRAPH = '__context_graph';

async function loadSavedQueriesForCatalog(contextGraphId: string): Promise<QueryCatalogItem[]> {
  const client = await ApiClient.connect();
  const result = await client.readQueryCatalog(contextGraphId);
  const bindings = result.result.type === 'bindings' ? result.result.bindings : [];
  return bindings
    .map((row) => {
      const qIri = stripQuotes(String(row.q ?? ''));
      const catalogIri = stripQuotes(String(row.catalog ?? ''));
      const slug = qIri.split(':query:').pop() ?? qIri;
      const catalogSlug = catalogIri ? (catalogIri.split(':catalog:').pop() ?? catalogIri) : 'ui-saved-queries';
      return {
        slug,
        name: stripQuotes(String(row.name ?? slug)),
        description: row.description ? stripQuotes(String(row.description)) : undefined,
        sparql: stripQuotes(String(row.sparql ?? '')),
        resultColumn: row.resultColumn ? stripQuotes(String(row.resultColumn)) : undefined,
        rank: Number.parseInt(stripQuotes(String(row.rank ?? '99')), 10) || 99,
        catalogSlug,
        catalogName: stripQuotes(String(row.catalogName ?? 'Queries')),
        catalogDescription: row.catalogDescription ? stripQuotes(String(row.catalogDescription)) : undefined,
        catalogRank: Number.parseInt(stripQuotes(String(row.catalogRank ?? '999')), 10) || 999,
        subGraph: stripQuotes(String(row.subGraph ?? '')),
      };
    })
    .filter((item) => item.sparql.length > 0)
    .sort((a, b) => a.subGraph.localeCompare(b.subGraph) || a.catalogRank - b.catalogRank || a.rank - b.rank || a.name.localeCompare(b.name));
}

function findSavedQuery(items: QueryCatalogItem[], selector: string): QueryCatalogItem | undefined {
  return items.find((item) => item.slug === selector)
    ?? items.find((item) => item.name === selector);
}

// ─── dkg query-catalog ───────────────────────────────────────────────

const queryCatalogCmd = program
  .command('query-catalog')
  .description('List and run saved SPARQL queries from the profile catalog');

queryCatalogCmd
  .command('list <context-graph>')
  .description('List saved queries in the profile query catalog')
  .action(async (contextGraphId: string) => {
    try {
      const items = await loadSavedQueriesForCatalog(contextGraphId);
      if (items.length === 0) {
        console.log(`No saved queries found for ${contextGraphId}.`);
        return;
      }
      console.log(`Saved queries for ${contextGraphId}:\n`);
      for (const item of items) {
        console.log(`${item.slug}`);
        console.log(`  Name:        ${item.name}`);
        console.log(`  Catalog:     ${item.catalogName} (${item.catalogSlug})`);
        console.log(`  Sub-graph:   ${item.subGraph}`);
        if (item.resultColumn) console.log(`  Result col:  ${item.resultColumn}`);
        if (item.description) console.log(`  Description: ${item.description}`);
        console.log('');
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

queryCatalogCmd
  .command('run <context-graph> <query>')
  .description('Run a saved query by slug or exact name')
  .action(async (contextGraphId: string, selector: string) => {
    try {
      const items = await loadSavedQueriesForCatalog(contextGraphId);
      const match = findSavedQuery(items, selector);
      if (!match) {
        console.error(`Saved query not found: ${selector}`);
        process.exit(1);
      }
      const client = await ApiClient.connect();
      const result = await client.query(
        match.sparql,
        contextGraphId,
        match.subGraph && match.subGraph !== CONTEXT_GRAPH_QUERY_SUBGRAPH
          ? { subGraphName: match.subGraph }
          : undefined,
      );
      console.log(`Running saved query: ${match.name}`);
      console.log(`Slug: ${match.slug}\n`);
      console.log(JSON.stringify(result.result, null, 2));
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

}
