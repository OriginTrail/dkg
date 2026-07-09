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

export function registerEpcisCommand(program: Command): void {
// ─── dkg epcis ───────────────────────────────────────────────────────

const EPCIS_EXIT_CODES = {
  SUCCESS: 0,
  UNEXPECTED: 1,
  CLIENT_ERROR: 2,
  PUBLISHER_UNAVAILABLE: 3,
  NOT_FOUND: 4,
} as const;

function exitCodeForEpcisHttpStatus(status: number | undefined): number {
  if (status === undefined) return EPCIS_EXIT_CODES.UNEXPECTED;
  if (status >= 200 && status < 300) return EPCIS_EXIT_CODES.SUCCESS;
  if (status === 503) return EPCIS_EXIT_CODES.PUBLISHER_UNAVAILABLE;
  if (status === 404) return EPCIS_EXIT_CODES.NOT_FOUND;
  if (status >= 400 && status < 500) return EPCIS_EXIT_CODES.CLIENT_ERROR;
  return EPCIS_EXIT_CODES.UNEXPECTED;
}

function reportEpcisError(err: unknown): never {
  const httpStatus = (err as { httpStatus?: number })?.httpStatus;
  const responseBody = (err as { responseBody?: unknown })?.responseBody;
  const code = exitCodeForEpcisHttpStatus(httpStatus);
  if (responseBody !== undefined) {
    try {
      console.log(JSON.stringify(responseBody, null, 2));
    } catch {
      // not serialisable
    }
  }
  console.error(toErrorMessage(err));
  process.exit(code);
}

const epcisCmd = program
  .command('epcis')
  .description('EPCIS 2.0 capture, status, and event query');

const ALLOWED_ACCESS_POLICIES = new Set(['public', 'ownerOnly', 'allowList']);

epcisCmd
  .command('capture <document>')
  .description('Submit an EPCIS 2.0 document for async capture')
  .option('--context-graph-id <id>', 'Target context graph (overrides config + document envelope)')
  .option('--sub-graph-name <name>', 'Sub-graph within the context graph')
  .option('--access-policy <policy>', 'public | ownerOnly | allowList')
  .option('--allowed-peer <peerId>', 'Peer allowed to read the captured event (repeatable, requires --access-policy allowList)', (value: string, prev: string[] = []) => [...prev, value])
  .action(async (documentPath: string, opts: ActionOpts) => {
    try {
      // Document file may be a bare EPCIS 2.0 doc or a `{ epcisDocument, ... }`
      // envelope; CLI flags override fields read from the file.
      const { readFile } = await import('node:fs/promises');
      let raw: string;
      try {
        raw = await readFile(documentPath, 'utf-8');
      } catch (err) {
        console.error(`Failed to read ${documentPath}: ${toErrorMessage(err)}`);
        process.exit(EPCIS_EXIT_CODES.UNEXPECTED);
      }
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.error(`Invalid JSON in ${documentPath}: ${toErrorMessage(err)}`);
        process.exit(EPCIS_EXIT_CODES.UNEXPECTED);
      }

      const isEnvelope = parsed && typeof parsed === 'object' && 'epcisDocument' in parsed;
      const epcisDocument = isEnvelope ? parsed.epcisDocument : parsed;
      const filePublishOptions = isEnvelope ? parsed.publishOptions : undefined;
      const fileContextGraphId = isEnvelope ? parsed.contextGraphId : undefined;
      const fileSubGraphName = isEnvelope ? parsed.subGraphName : undefined;

      const accessPolicy = opts.accessPolicy as string | undefined;
      if (accessPolicy !== undefined && !ALLOWED_ACCESS_POLICIES.has(accessPolicy)) {
        console.error(`Invalid --access-policy "${accessPolicy}". Use one of: public, ownerOnly, allowList.`);
        process.exit(EPCIS_EXIT_CODES.UNEXPECTED);
      }
      const allowedPeers = opts.allowedPeer as string[] | undefined;
      // Validation of `allowedPeers requires accessPolicy === 'allowList'`
      // runs against the EFFECTIVE merged policy below (post-`merged`
      // construction). Validating the raw `--access-policy` flag here
      // would reject `dkg epcis capture envelope.json --allowed-peer X`
      // when the envelope already supplies `accessPolicy: 'allowList'`,
      // which is a perfectly valid combination — the flag adds peers,
      // the envelope sets the policy.

      const publishOptions = (() => {
        const merged = { ...(filePublishOptions ?? {}) } as {
          accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
          allowedPeers?: string[];
        };
        if (accessPolicy !== undefined) {
          merged.accessPolicy = accessPolicy as 'public' | 'ownerOnly' | 'allowList';
        }
        if (allowedPeers && allowedPeers.length > 0) {
          merged.allowedPeers = allowedPeers;
        }
        return Object.keys(merged).length > 0 ? merged : undefined;
      })();
      if (publishOptions) {
        if (publishOptions.accessPolicy !== undefined && !ALLOWED_ACCESS_POLICIES.has(publishOptions.accessPolicy)) {
          console.error(`Invalid publishOptions.accessPolicy "${publishOptions.accessPolicy}". Use one of: public, ownerOnly, allowList.`);
          process.exit(EPCIS_EXIT_CODES.UNEXPECTED);
        }
        if (publishOptions.allowedPeers && publishOptions.allowedPeers.length > 0 && publishOptions.accessPolicy !== 'allowList') {
          console.error('publishOptions.allowedPeers requires accessPolicy "allowList".');
          process.exit(EPCIS_EXIT_CODES.UNEXPECTED);
        }
      }

      // Use explicit `!== undefined` checks (not truthiness) so an
      // envelope file that explicitly sets `"contextGraphId": ""` or
      // `"subGraphName": ""` round-trips to the server as an empty
      // string. The server's resolveCgId/resolveSubGraphName then
      // returns a precise 400 instead of silently falling back to the
      // daemon default CG / root partition. Truthiness drops empty
      // strings into the "not provided" bucket, which masks the
      // misconfiguration as a successful capture against the wrong
      // partition.
      const request = {
        epcisDocument,
        ...(opts.contextGraphId !== undefined
          ? { contextGraphId: String(opts.contextGraphId) }
          : fileContextGraphId !== undefined
            ? { contextGraphId: String(fileContextGraphId) }
            : {}),
        ...(opts.subGraphName !== undefined
          ? { subGraphName: String(opts.subGraphName) }
          : fileSubGraphName !== undefined
            ? { subGraphName: String(fileSubGraphName) }
            : {}),
        ...(publishOptions ? { publishOptions } : {}),
      };

      const client = await ApiClient.connect();
      const result = await client.captureEpcis(request);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      reportEpcisError(err);
    }
  });

epcisCmd
  .command('status <captureID>')
  .description('Get the status of an async EPCIS capture job')
  .action(async (captureID: string) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.getEpcisCapture(captureID);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      reportEpcisError(err);
    }
  });

epcisCmd
  .command('query')
  .description('Query EPCIS events from a context graph')
  .option('--context-graph-id <id>', 'Target context graph (overrides config default)')
  .option('--sub-graph-name <name>', 'Sub-graph within the context graph')
  .option('--finalized <bool>', 'true | false (default: server default)')
  .option('--epc <epc>', 'Filter by EPC')
  .option('--biz-step <step>', 'Filter by bizStep')
  .option('--from <ts>', 'Filter by lower bound on eventTime')
  .option('--to <ts>', 'Filter by upper bound on eventTime')
  .option('--event-id <id>', 'Filter by eventID')
  .option('--event-type <type>', 'Filter by eventType (e.g. ObjectEvent)')
  .option('--action <a>', 'Filter by action (ADD | OBSERVE | DELETE)')
  .option('--disposition <d>', 'Filter by disposition')
  .option('--read-point <uri>', 'Filter by readPoint id')
  .option('--biz-location <uri>', 'Filter by bizLocation id')
  .option('--configuration-id <id>', 'Filter by extension configurationId')
  .option('--shipment-id <id>', 'Filter by extension shipmentId')
  .option('--per-page <n>', 'Page size')
  .option('--next-page-token <t>', 'Continuation token from a prior response')
  .option('--all', 'Follow Link: rel="next" pages and merge eventList in-place')
  .action(async (opts: ActionOpts) => {
    try {
      const finalized = (() => {
        if (opts.finalized === undefined) return undefined;
        const lowered = String(opts.finalized).toLowerCase();
        if (lowered === 'true') return true;
        if (lowered === 'false') return false;
        console.error(`Invalid --finalized "${opts.finalized}". Use "true" or "false".`);
        process.exit(EPCIS_EXIT_CODES.UNEXPECTED);
      })();
      const perPage = opts.perPage !== undefined
        ? Number.parseInt(String(opts.perPage), 10)
        : undefined;
      if (perPage !== undefined && (!Number.isFinite(perPage) || perPage <= 0)) {
        console.error(`Invalid --per-page "${opts.perPage}". Use a positive integer.`);
        process.exit(EPCIS_EXIT_CODES.UNEXPECTED);
      }

      const params = {
        ...(opts.contextGraphId ? { contextGraphId: String(opts.contextGraphId) } : {}),
        ...(opts.subGraphName ? { subGraphName: String(opts.subGraphName) } : {}),
        ...(finalized !== undefined ? { finalized } : {}),
        ...(opts.epc ? { epc: String(opts.epc) } : {}),
        ...(opts.bizStep ? { bizStep: String(opts.bizStep) } : {}),
        ...(opts.from ? { from: String(opts.from) } : {}),
        ...(opts.to ? { to: String(opts.to) } : {}),
        ...(opts.eventId ? { eventID: String(opts.eventId) } : {}),
        ...(opts.eventType ? { eventType: String(opts.eventType) } : {}),
        ...(opts.action ? { action: String(opts.action) } : {}),
        ...(opts.disposition ? { disposition: String(opts.disposition) } : {}),
        ...(opts.readPoint ? { readPoint: String(opts.readPoint) } : {}),
        ...(opts.bizLocation ? { bizLocation: String(opts.bizLocation) } : {}),
        ...(opts.configurationId ? { configurationId: String(opts.configurationId) } : {}),
        ...(opts.shipmentId ? { shipmentId: String(opts.shipmentId) } : {}),
        ...(perPage !== undefined ? { perPage } : {}),
        ...(opts.nextPageToken ? { nextPageToken: String(opts.nextPageToken) } : {}),
      };

      const client = await ApiClient.connect();
      const initial = await client.queryEpcisEvents(params);

      if (!opts.all) {
        const out: Record<string, unknown> = { ...((initial.body ?? {}) as Record<string, unknown>) };
        if (initial.nextPageUrl) {
          out.nextPageUrl = initial.nextPageUrl;
        }
        console.log(JSON.stringify(out, null, 2));
        return;
      }

      const merged = JSON.parse(JSON.stringify(initial.body)) as any;
      const eventList = merged?.epcisBody?.queryResults?.resultsBody?.eventList;
      if (!Array.isArray(eventList)) {
        console.error('Cannot follow Link: rel="next" — initial response shape unexpected.');
        process.exit(EPCIS_EXIT_CODES.UNEXPECTED);
      }
      let nextUrl = initial.nextPageUrl;
      const MAX_PAGES = 1000;
      let pages = 1;
      while (nextUrl) {
        if (pages >= MAX_PAGES) {
          console.error(`Aborting --all after ${MAX_PAGES} pages (suspected loop).`);
          process.exit(EPCIS_EXIT_CODES.UNEXPECTED);
        }
        const next = await client.queryEpcisEventsByPath(nextUrl);
        const nextEventList = (next.body as any)?.epcisBody?.queryResults?.resultsBody?.eventList;
        if (!Array.isArray(nextEventList)) {
          console.error(`Cannot follow Link: rel="next" — page ${pages + 1} response shape unexpected.`);
          process.exit(EPCIS_EXIT_CODES.UNEXPECTED);
        }
        eventList.push(...nextEventList);
        nextUrl = next.nextPageUrl;
        pages += 1;
      }
      console.log(JSON.stringify(merged, null, 2));
    } catch (err) {
      reportEpcisError(err);
    }
  });

}
