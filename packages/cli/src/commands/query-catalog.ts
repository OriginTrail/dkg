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
  parseQueryCatalogParameters,
  renderQueryCatalogTemplate,
  type QueryCatalogParameterDefinition,
} from '@origintrail-official/dkg-core/query-catalog-parameters';
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
  parameters: QueryCatalogParameterDefinition[];
  view?: 'working-memory' | 'shared-working-memory' | 'verifiable-memory';
};

const CONTEXT_GRAPH_QUERY_SUBGRAPH = '__context_graph';

async function loadSavedQueriesForCatalog(contextGraphId: string): Promise<QueryCatalogItem[]> {
  const client = await ApiClient.connect();
  const result = await client.readQueryCatalog(contextGraphId);
  const bindings = result.result.type === 'bindings' ? result.result.bindings : [];
  return bindings
    .map((row) => {
      const qIri = catalogBindingValue(row.q);
      const catalogIri = catalogBindingValue(row.catalog);
      const slug = qIri.split(':query:').pop() ?? qIri;
      const catalogSlug = catalogIri ? (catalogIri.split(':catalog:').pop() ?? catalogIri) : 'ui-saved-queries';
      return {
        slug,
        name: catalogBindingValue(row.name) || slug,
        description: row.description ? catalogBindingValue(row.description) : undefined,
        sparql: catalogBindingValue(row.sparql),
        resultColumn: row.resultColumn ? catalogBindingValue(row.resultColumn) : undefined,
        rank: Number.parseInt(catalogBindingValue(row.rank) || '99', 10) || 99,
        catalogSlug,
        catalogName: catalogBindingValue(row.catalogName) || 'Queries',
        catalogDescription: row.catalogDescription ? catalogBindingValue(row.catalogDescription) : undefined,
        catalogRank: Number.parseInt(catalogBindingValue(row.catalogRank) || '999', 10) || 999,
        subGraph: catalogBindingValue(row.subGraph),
        parameters: parseQueryCatalogParameters(
          row.queryParameters ? catalogBindingValue(row.queryParameters) : undefined,
        ),
        view: savedQueryView(row.executionView ?? row.view),
      };
    })
    .filter((item) => item.sparql.length > 0)
    .sort((a, b) => a.subGraph.localeCompare(b.subGraph) || a.catalogRank - b.catalogRank || a.rank - b.rank || a.name.localeCompare(b.name));
}

function catalogBindingValue(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const bindingValue = (value as { value?: unknown }).value;
    if (typeof bindingValue === 'string') return bindingValue;
  }
  return stripQuotes(String(value ?? ''));
}

function savedQueryView(value: unknown): QueryCatalogItem['view'] {
  const normalized = catalogBindingValue(value);
  return normalized === 'working-memory'
    || normalized === 'shared-working-memory'
    || normalized === 'verifiable-memory'
    ? normalized
    : undefined;
}

function collectQueryParameter(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseQueryParameterValues(entries: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error(`Invalid --param value: ${entry}. Expected name=value.`);
    const name = entry.slice(0, separator).trim();
    if (!name) throw new Error(`Invalid --param value: ${entry}. Expected name=value.`);
    values[name] = entry.slice(separator + 1);
  }
  return values;
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
        if (item.parameters.length > 0) {
          console.log(`  Parameters:  ${item.parameters.map(parameter => `${parameter.name}:${parameter.type}`).join(', ')}`);
        }
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
  .option('-p, --param <name=value>', 'Runtime query parameter (repeatable)', collectQueryParameter, [])
  .action(async (contextGraphId: string, selector: string, options: { param: string[] }) => {
    try {
      const items = await loadSavedQueriesForCatalog(contextGraphId);
      const match = findSavedQuery(items, selector);
      if (!match) {
        console.error(`Saved query not found: ${selector}`);
        process.exit(1);
      }
      const client = await ApiClient.connect();
      const sparql = renderQueryCatalogTemplate(
        match.sparql,
        match.parameters,
        parseQueryParameterValues(options.param),
      );
      const queryOptions = {
        ...(match.subGraph && match.subGraph !== CONTEXT_GRAPH_QUERY_SUBGRAPH
          ? { subGraphName: match.subGraph }
          : {}),
        ...(match.view ? { view: match.view } : {}),
      };
      const result = await client.query(
        sparql,
        contextGraphId,
        Object.keys(queryOptions).length > 0 ? queryOptions : undefined,
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
