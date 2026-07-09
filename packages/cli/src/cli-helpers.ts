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
} from './config.js';
import { ApiClient } from './api-client.js';
import { parsePositiveIntegerOption, parsePositiveMsOption } from './cli-option-parsers.js';
import { promptStoreBackend, applyStoreFlagsToConfig } from './store-wizard.js';
import { runConfiguredSourceWorker } from './source-worker-runner.js';
import { batchEntityQuads } from './batching.js';
import {
  runDaemon,
  checkForNpmVersionUpdate,
  performNpmUpdate,
  performNpmUpdateEdge,
  getCurrentCliVersion,
  DAEMON_EXIT_CODE_RESTART,
  resolveStandaloneInstall,
  decodeForcedExitCode,
} from './daemon.js';
import {
  isLivenessProbeEnabled,
  startLivenessWatcher,
  LIVENESS_CONSECUTIVE_FAILURES_TO_KILL,
} from './daemon/supervisor-liveness.js';
import { migrateToBlueGreen, noteEdgeLegacyReleases } from './migration.js';
import { ensureRollbackNodeUiBundle } from './rollback-node-ui.js';

function isDaemonUnreachable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Daemon is not running') || msg.includes('Cannot read API port')) return true;
  const code = (err as any)?.cause?.code ?? (err as any)?.code;
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return true;
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) return true;
  const httpStatus = (err as any)?.httpStatus as number | undefined;
  if (typeof httpStatus === 'number') {
    if (httpStatus === 405 || httpStatus === 501) return true;
    if (httpStatus === 404) {
      const lower = msg.toLowerCase();
      return lower === 'not found' || lower === `http ${httpStatus}`;
    }
    return false;
  }
  const lower = msg.toLowerCase();
  if (lower.includes('not found') || lower.includes('not allowed') || lower.includes('not implemented')
    || /HTTP (404|405|501)/i.test(msg)) return true;
  return false;
}

/** Commander action callbacks receive parsed .option() values with loose types. */
type ActionOpts = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const VERIFY_COLLECTION_TIMEOUT_MIN_MS = 1_000;
const VERIFY_COLLECTION_TIMEOUT_MAX_MS = 30 * 60 * 1000;

function cliSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cliErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

const STARTUP_BANNER = `
\x1b[36m██████╗ ██╗  ██╗ ██████╗     ██╗   ██╗ ██╗ ██████╗
██╔══██╗██║ ██╔╝██╔════╝     ██║   ██║███║██╔═████╗
██║  ██║█████╔╝ ██║  ███╗    ██║   ██║╚██║██║██╔██║
██║  ██║██╔═██╗ ██║   ██║    ╚██╗ ██╔╝ ██║████╔╝██║
██████╔╝██║  ██╗╚██████╔╝     ╚████╔╝  ██║╚██████╔╝
╚═════╝ ╚═╝  ╚═╝ ╚═════╝       ╚═══╝   ╚═╝ ╚═════╝\x1b[0m
`;

function normalizeVersionTagRef(input: string): string {
  const cleaned = input.trim();
  if (!cleaned) throw new Error(`Invalid version/ref: empty input`);
  if (cleaned.startsWith('refs/')) {
    const afterRefs = cleaned.replace(/^refs\/tags\/v?/, '');
    if (!afterRefs) throw new Error(`Invalid version/ref: "${input}"`);
    return cleaned;
  }
  const bare = cleaned.startsWith('v') ? cleaned.slice(1) : cleaned;
  if (!bare) throw new Error(`Invalid version/ref: "${input}"`);
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(bare)) {
    return `refs/tags/v${bare}`;
  }
  return cleaned;
}

function getCliVersion(): string {
  try {
    const path = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(path, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseOptionalVerifyTimeoutOption(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && /^\d+$/.test(raw.trim())
      ? Number(raw.trim())
      : NaN;
  if (
    !Number.isSafeInteger(value) ||
    value < VERIFY_COLLECTION_TIMEOUT_MIN_MS ||
    value > VERIFY_COLLECTION_TIMEOUT_MAX_MS
  ) {
    throw new Error(
      `--timeout must be an integer between ${VERIFY_COLLECTION_TIMEOUT_MIN_MS} ` +
        `and ${VERIFY_COLLECTION_TIMEOUT_MAX_MS} milliseconds`,
    );
  }
  return value;
}

function loadStructuredFile(filePath: string): any {
  const content = readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.json')) return JSON.parse(content);
  return yaml.load(content);
}

async function loadQuadsFromInput(
  opts: ActionOpts,
  defaultGraph: string,
): Promise<Array<{ subject: string; predicate: string; object: string; graph: string }>> {
  const rdfParser = await import('./rdf-parser.js');

  if (opts.file) {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(opts.file, 'utf-8');
    const format = opts.format ?? rdfParser.detectFormat(opts.file);
    const quads = await rdfParser.parseRdf(raw, format, defaultGraph);
    console.log(`Parsed ${quads.length} quad(s) from ${opts.file} (${format})`);
    return quads;
  }

  if (opts.triples) {
    const parsed = JSON.parse(opts.triples);
    return parsed.map((q: Record<string, string>) => ({ ...q, graph: q.graph || defaultGraph }));
  }

  if (opts.subject && opts.predicate && opts.object) {
    return [{
      subject: opts.subject,
      predicate: opts.predicate,
      object: opts.object.startsWith('"') || opts.object.startsWith('http') || opts.object.startsWith('did:')
        ? opts.object
        : `"${opts.object}"`,
      graph: defaultGraph,
    }];
  }

  console.error(`Provide --file (${rdfParser.supportedExtensions().join(', ')}), --triples, or --subject/--predicate/--object`);
  process.exit(1);
}

/**
 * Resolve the daemon entry point passed to spawned worker processes.
 *
 * OT-RFC-41 §4.1 / Bundle B1a: Edge nodes run from the npm-global
 * install (`import.meta.url`). Core nodes keep using blue-green
 * slots (`~/.dkg/releases/current`). The role gate is applied here
 * because the supervisor spawns workers via this entry point on
 * every restart — without the gate, an Edge node that had legacy
 * slots from a pre-rc.12 install would keep running the stale slot
 * forever even after `npm install -g` updated the global.
 */
/**
 * Absolute path to THIS CLI's own entrypoint module, used to respawn the
 * daemon worker. `resolveDaemonEntryPoint` lives in `cli-helpers`, a sibling
 * of the entry module (`cli.ts` → `cli.js` after `tsc`), so the entry is
 * resolved relative to this file and the extension that actually exists is
 * picked: a built install runs `cli.js`, while running from source (tsx /
 * ts-node) runs `cli.ts`. Hardcoding `.js` would respawn a nonexistent
 * `src/cli.js` under source mode (#962 review). This mirrors the pre-split
 * behavior where the helper lived in `cli.ts` and returned its own
 * `import.meta.url` — i.e. the real current entrypoint in either mode.
 */
function cliEntryPointPath(): string {
  const builtEntry = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (existsSync(builtEntry)) return builtEntry;
  const sourceEntry = fileURLToPath(new URL('./cli.ts', import.meta.url));
  if (existsSync(sourceEntry)) return sourceEntry;
  return builtEntry;
}

function resolveDaemonEntryPoint(): string {
  if (process.env.DKG_NO_BLUE_GREEN) return cliEntryPointPath();
  if (readNodeRoleFromConfigSync() === 'edge') return cliEntryPointPath();
  const rDir = releasesDir();
  if (existsSync(rDir)) {
    const entry = slotEntryPoint(join(rDir, 'current'));
    if (entry) return entry;
  }
  return cliEntryPointPath();
}

function probeHostForApiHost(apiHost: string | undefined): string {
  if (!apiHost || apiHost === '0.0.0.0') return '127.0.0.1';
  if (apiHost === '::') return '::1';
  return apiHost;
}

function selectedDkgHomeForEnv(env: NodeJS.ProcessEnv): string {
  return resolveDkgConfigHome({ env, isDkgMonorepo: isDkgMonorepo() });
}

function withSelectedDkgHome(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, DKG_HOME: selectedDkgHomeForEnv(env) };
}

type CatchupStatusCommandOptions = { watch?: boolean; interval?: string | number };

function printCatchupStatus(status: Awaited<ReturnType<ApiClient['catchupStatus']>>) {
  console.log(`Context Graph: ${status.contextGraphId}`);
  console.log(`Job:           ${status.jobId}`);
  console.log(`Status:        ${status.status}`);
  console.log(`Shared Memory: ${status.includeWorkspace ? 'enabled' : 'disabled'}`);
  console.log(`Queued:        ${new Date(status.queuedAt).toISOString()}`);
  if (status.startedAt) console.log(`Started:       ${new Date(status.startedAt).toISOString()}`);
  if (status.finishedAt) console.log(`Finished:      ${new Date(status.finishedAt).toISOString()}`);
  if (status.result) {
    const totalConnectedPeers = status.result.totalPeers ?? status.result.connectedPeers;
    console.log(
      `Result:        peers ${status.result.peersTried}/${status.result.syncCapablePeers} (connected ${totalConnectedPeers}), data ${status.result.dataSynced}, shared memory ${status.result.sharedMemorySynced}`,
    );
    if (status.result.diagnostics) {
      console.log(
        `Diagnostics:   no-protocol ${status.result.diagnostics.noProtocolPeers}, durable fetched meta/data ${status.result.diagnostics.durable.fetchedMetaTriples}/${status.result.diagnostics.durable.fetchedDataTriples}, inserted meta/data ${status.result.diagnostics.durable.insertedMetaTriples}/${status.result.diagnostics.durable.insertedDataTriples}`,
      );
      console.log(
        `               durable bytes ${status.result.diagnostics.durable.bytesReceived}, resumed phases ${status.result.diagnostics.durable.resumedPhases}, empty ${status.result.diagnostics.durable.emptyResponses}, meta-only ${status.result.diagnostics.durable.metaOnlyResponses}, no-meta rejects ${status.result.diagnostics.durable.dataRejectedMissingMeta}, rejected KCs ${status.result.diagnostics.durable.rejectedKcs}, transport failures ${status.result.diagnostics.durable.failedPeers}, phase failures ${status.result.diagnostics.durable.failedPhases ?? 0}`,
      );
      console.log(
        `               swm fetched meta/data ${status.result.diagnostics.sharedMemory.fetchedMetaTriples}/${status.result.diagnostics.sharedMemory.fetchedDataTriples}, inserted meta/data ${status.result.diagnostics.sharedMemory.insertedMetaTriples}/${status.result.diagnostics.sharedMemory.insertedDataTriples}, bytes ${status.result.diagnostics.sharedMemory.bytesReceived}, resumed phases ${status.result.diagnostics.sharedMemory.resumedPhases}, empty ${status.result.diagnostics.sharedMemory.emptyResponses}, dropped ${status.result.diagnostics.sharedMemory.droppedDataTriples}, transport failures ${status.result.diagnostics.sharedMemory.failedPeers}, phase failures ${status.result.diagnostics.sharedMemory.failedPhases ?? 0}`,
      );
    }
  }
  if (status.error) {
    console.log(`Error:         ${status.error}`);
  }
  if (
    status.result &&
    (status.result.selectedPeers ?? status.result.connectedPeers) >= (status.result.totalPeers ?? status.result.connectedPeers) &&
    (status.result.totalPeers ?? status.result.connectedPeers) > 0 &&
    status.result.syncCapablePeers === 0 &&
    status.result.dataSynced === 0 &&
    status.result.sharedMemorySynced === 0
  ) {
    console.log('Warning:       Connected peers were found, but none advertised the sync protocol.');
  }
}

async function runCatchupStatusCommand(contextGraph: string, opts: CatchupStatusCommandOptions) {
  const client = await ApiClient.connect();
  const watch = !!opts.watch;
  const intervalSeconds = Math.max(1, Number(opts.interval ?? 2));
  const terminalStates = new Set(['done', 'failed', 'denied', 'unreachable']);

  do {
    const status = await client.catchupStatus(contextGraph);
    if (watch) {
      console.clear();
      console.log(`Watching catch-up status every ${intervalSeconds}s\n`);
    }
    printCatchupStatus(status);
    if (!watch || terminalStates.has(status.status)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  } while (true);
}

function printMessage(
  m: { ts: number; direction: string; peer: string; text: string },
  selfName: string,
  nameMap?: Map<string, string>,
) {
  const time = new Date(m.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const who = m.direction === 'in'
    ? (nameMap?.get(m.peer) ?? shortId(m.peer))
    : selfName;
  console.log(`  [${time}] ${who}: ${m.text}`);
}

function shortId(peerId: string): string {
  if (peerId.length > 16) return peerId.slice(0, 8) + '...' + peerId.slice(-4);
  return peerId;
}

function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

async function publishEntityBatches(
  quads: Array<{ subject: string; predicate: string; object: string; graph: string }>,
  applyBatch: (batch: Array<{ subject: string; predicate: string; object: string; graph: string }>) => Promise<unknown>,
  onProgress?: (publishedQuadCount: number) => void,
  options: {
    maxBatchBytes?: number;
    estimateBatchBytes?: (batch: Array<{ subject: string; predicate: string; object: string; graph: string }>) => number;
    splitOversizedEntities?: boolean;
  } = {},
): Promise<void> {
  let sent = 0;
  const batches = batchEntityQuads(quads, {
    maxBatchQuads: 500,
    maxBatchBytes: options.maxBatchBytes,
    estimateBatchBytes: options.estimateBatchBytes,
    splitOversizedEntities: options.splitOversizedEntities,
  });

  for (const batch of batches) {
    await applyBatch(batch);
    sent += batch.length;
    onProgress?.(sent);
  }
}

function formatPublisherJobOutput<T>(value: T): T {
  return formatPublisherJobValue(value) as T;
}

function formatPublisherJobValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => formatPublisherJobValue(item));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = formatPublisherJobValue(entryValue, entryKey);
    }
    return result;
  }
  if (typeof value === 'number' && key && /At$/.test(key)) {
    return new Date(value).toISOString();
  }
  return value;
}

function stripQuotes(s: string): string {
  const decodeLiteral = (literal: string): string => {
    try {
      return JSON.parse(literal);
    } catch {
      return literal.slice(1, -1);
    }
  };
  if (s.startsWith('"') && s.endsWith('"')) return decodeLiteral(s);
  const match = s.match(/^(".*")(\^\^.*|@.*)?$/);
  if (match) return decodeLiteral(match[1]);
  return s;
}

function formatQuadObject(object: string): string {
  return /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(object) ? `<${object}>` : object;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Returns true if daemon was stopped (or not running). False if it couldn't be stopped. */
async function stopDaemonIfRunning(): Promise<boolean> {
  const pid = await readPid();
  if (!pid || !isProcessRunning(pid)) return true;
  console.log('Stopping daemon...');
  try { process.kill(pid, 'SIGTERM'); } catch (err) {
    if (!hasErrorCode(err, 'ESRCH')) throw err;
  }
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (!isProcessRunning(pid)) return true;
  }
  console.error('Daemon is still running after SIGTERM. Stop it manually before restarting.');
  return false;
}

export {
  isDaemonUnreachable,
  VERIFY_COLLECTION_TIMEOUT_MIN_MS,
  VERIFY_COLLECTION_TIMEOUT_MAX_MS,
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
};
export type { ActionOpts, CatchupStatusCommandOptions };

