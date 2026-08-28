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
  decodeQueryCatalogReadResponse,
  prepareQueryCatalogExecution,
  type QueryCatalogItem,
} from '@origintrail-official/dkg-core/query-catalog';
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
async function loadSavedQueriesForCatalog(contextGraphId: string): Promise<QueryCatalogItem[]> {
  const client = await ApiClient.connect();
  const result = await client.readQueryCatalog(contextGraphId);
  return decodeQueryCatalogReadResponse(result);
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

function qualifiedSavedQuerySelector(item: QueryCatalogItem): string {
  return `${item.subGraph}/${item.catalogSlug}/${item.slug}`;
}

function findSavedQuery(items: QueryCatalogItem[], selector: string): QueryCatalogItem | undefined {
  const qualified = items.filter((item) => qualifiedSavedQuerySelector(item) === selector);
  if (qualified.length === 1) return qualified[0];
  const matches = items.filter((item) => item.slug === selector || item.name === selector);
  if (matches.length > 1) {
    throw new Error(
      `Saved query selector is ambiguous: ${selector}. Use one of: `
      + matches.map(qualifiedSavedQuerySelector).join(', '),
    );
  }
  return matches[0];
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
        console.log(`  Selector:    ${qualifiedSavedQuerySelector(item)}`);
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
      const execution = prepareQueryCatalogExecution(
        match,
        parseQueryParameterValues(options.param),
      );
      const queryOptions = {
        ...(execution.subGraphName ? { subGraphName: execution.subGraphName } : {}),
        ...(execution.view ? { view: execution.view } : {}),
      };
      const result = await client.query(
        execution.sparql,
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
