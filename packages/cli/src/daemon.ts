import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { execSync, exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
import { join, dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { ethers } from 'ethers';
import { DKGAgent, loadOpWallets } from '@origintrail-official/dkg-agent';
import { computeNetworkId, createOperationContext, DKGEvent, Logger, PayloadTooLargeError, GET_VIEWS, validateSubGraphName, validateAssertionName, validateContextGraphId, isSafeIri, contextGraphSharedMemoryUri, contextGraphAssertionUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import {
  DashboardDB,
  MetricsCollector,
  OperationTracker,
  handleNodeUIRequest,
  ChatAssistant,
  ChatMemoryManager,
  LogPushWorker,
  type MetricsSource,
} from '@origintrail-official/dkg-node-ui';
import {
  loadConfig,
  saveConfig,
  loadNetworkConfig,
  dkgDir,
  writePid,
  removePid,
  writeApiPort,
  removeApiPort,
  logPath,
  ensureDkgDir,
  TELEMETRY_ENDPOINTS,
  type DkgConfig,
  type AutoUpdateConfig,
  resolveContextGraphs,
  resolveNetworkDefaultContextGraphs,
  resolveSharedMemoryTtlMs,
  repoDir,
  releasesDir,
  activeSlot,
  inactiveSlot,
  swapSlot,
  gitCommandEnv,
  gitCommandArgs,
  isStandaloneInstall,
  slotEntryPoint,
  CLI_NPM_PACKAGE,
} from './config.js';
import { createPublisherControlFromStore, startPublisherRuntimeIfEnabled, type PublisherRuntime } from './publisher-runner.js';
import { loadTokens, httpAuthGuard, extractBearerToken } from './auth.js';
import { ExtractionPipelineRegistry } from '@origintrail-official/dkg-core';
import { MarkItDownConverter, isMarkItDownAvailable, extractFromMarkdown } from './extraction/index.js';
import { type ExtractionStatusRecord, getExtractionStatusRecord, setExtractionStatusRecord } from './extraction-status.js';
import { FileStore } from './file-store.js';
import { parseBoundary, parseMultipart, MultipartParseError } from './http/multipart.js';
import { handleCapture, EpcisValidationError, handleEventsQuery, EpcisQueryError, type Publisher as EpcisPublisher } from '@origintrail-official/dkg-epcis';
import { readFileSync } from 'node:fs';

function getNodeVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch { return '0.0.0'; }
}

function getCurrentCommitShort(): string {
  try {
    const commitFile = join(dkgDir(), '.current-commit');
    return readFileSync(commitFile, 'utf-8').trim().slice(0, 8);
  } catch {
    try {
      const rDir = releasesDir();
      const slotDir = existsSync(join(rDir, 'current'))
        ? join(rDir, 'current')
        : dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      return execSync('git rev-parse --short=8 HEAD', { encoding: 'utf-8', stdio: 'pipe', cwd: slotDir }).trim();
    } catch { return ''; }
  }
}

// ---------------------------------------------------------------------------
// SKILL.MD serving — Agent Skills standard (https://agentskills.io)
// ---------------------------------------------------------------------------

let cachedSkillMd: string | null = null;
let cachedSkillEtag: string | null = null;

function loadSkillTemplate(): string {
  if (cachedSkillMd) return cachedSkillMd;
  const skillPath = new URL('../skills/dkg-node/SKILL.md', import.meta.url);
  const content = readFileSync(skillPath, 'utf-8');
  cachedSkillMd = content;
  return content;
}

function buildSkillMd(opts: {
  version: string;
  baseUrl: string;
  peerId: string;
  nodeRole: string;
  extractionPipelines: string[];
}): string {
  const template = loadSkillTemplate();
  const dynamicSection = [
    `- **Node version:** ${opts.version}`,
    `- **Base URL:** ${opts.baseUrl}`,
    `- **Peer ID:** ${opts.peerId}`,
    `- **Node role:** ${opts.nodeRole}`,
    `- **Available extraction pipelines:** ${opts.extractionPipelines.length > 0 ? opts.extractionPipelines.join(', ') : 'none (install markitdown to enable document conversion)'}`,
    `- **Subscribed Context Graphs:** use \`GET /api/context-graph/list\` (requires auth)`,
  ].join('\n');

  const staticPlaceholder =
    '> This section is dynamically generated from node state at serve-time.\n\n'
    + '- **Node version:** (dynamic)\n'
    + '- **Base URL:** (dynamic)\n'
    + '- **Peer ID:** (dynamic)\n'
    + '- **Node role:** (dynamic — `core` or `edge`)\n'
    + '- **Available extraction pipelines:** (dynamic)\n'
    + '- **Subscribed Context Graphs:** (dynamic)';

  return template.replace(staticPlaceholder, dynamicSection);
}

function skillEtag(content: string): string {
  return '"' + createHash('md5').update(content).digest('hex').slice(0, 16) + '"';
}

import { loadApps, handleAppRequest, startAppStaticServer, type LoadedApp } from './app-loader.js';

export const DAEMON_EXIT_CODE_RESTART = 75;

/**
 * Validate and parse a `requiredSignatures` value from an API request body.
 * Returns `{ value }` on success or `{ error }` on failure.
 */
export function parseRequiredSignatures(raw: unknown): { value: number } | { error: string } {
  if (raw === undefined) return { value: 0 };
  if (typeof raw !== 'number') return { error: 'requiredSignatures must be a number' };
  if (!Number.isInteger(raw) || raw < 1) return { error: 'requiredSignatures must be a positive integer (>= 1)' };
  return { value: raw };
}

function normalizeDetectedContentType(contentType: string | undefined): string {
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : 'application/octet-stream';
}

const lastUpdateCheck = { upToDate: true, checkedAt: 0, latestCommit: '', latestVersion: '' };
let isUpdating = false;

type CatchupJobState = 'queued' | 'running' | 'done' | 'failed';

interface CatchupJobResult {
  connectedPeers: number;
  syncCapablePeers: number;
  peersTried: number;
  dataSynced: number;
  sharedMemorySynced: number;
}

interface CatchupJob {
  jobId: string;
  paranetId: string;
  includeWorkspace: boolean; // kept for wire compat; semantically "includeSharedMemory"
  status: CatchupJobState;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: CatchupJobResult;
  error?: string;
}

interface CatchupTracker {
  jobs: Map<string, CatchupJob>;
  latestByParanet: Map<string, string>;
}

type PublishAccessPolicy = 'public' | 'ownerOnly' | 'allowList';

interface PublishQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

interface PublishRequestBody {
  paranetId: string;
  quads: PublishQuad[];
  privateQuads?: PublishQuad[];
  accessPolicy?: PublishAccessPolicy;
  allowedPeers?: string[];
  subGraphName?: string;
}


export async function runDaemon(foreground: boolean): Promise<void> {
  await ensureDkgDir();
  const config = await loadConfig();
  const startedAt = Date.now();

  // Write PID early so the CLI detects the process is alive while
  // initialization (sync, on-chain identity, profile publish) proceeds.
  // Wrapped in try/finally so the PID file is cleaned up if boot fails.
  await writePid(process.pid);
  try {
    await runDaemonInner(foreground, config, startedAt);
  } catch (err) {
    await removePid().catch(() => {});
    throw err;
  }
}

async function runDaemonInner(foreground: boolean, config: Awaited<ReturnType<typeof loadConfig>>, startedAt: number): Promise<void> {
  const logFile = logPath();

  // Tee all stdout/stderr (including structured Logger output) into the log file
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    appendFile(logFile, typeof chunk === 'string' ? chunk : chunk.toString()).catch(() => {});
    return origStdoutWrite(chunk, ...args);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    appendFile(logFile, typeof chunk === 'string' ? chunk : chunk.toString()).catch(() => {});
    return origStderrWrite(chunk, ...args);
  }) as typeof process.stderr.write;

  function log(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    if (foreground) origStdoutWrite(line + '\n');
    appendFile(logFile, line + '\n').catch(() => {});
  }

  process.on('uncaughtException', (err) => {
    const msg = err?.message ?? String(err);
    if (msg.includes('Cannot write to a stream that is') || msg.includes('StreamStateError')) {
      log(`[warn] Suppressed GossipSub stream error: ${msg}`);
      return;
    }
    log(`[fatal] Uncaught exception: ${err?.stack ?? msg}`);
    removePid().catch(() => {}).finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (msg.includes('Cannot write to a stream that is') || msg.includes('StreamStateError')) {
      log(`[warn] Suppressed GossipSub stream rejection: ${msg}`);
      return;
    }
    log(`[warn] Unhandled rejection: ${reason instanceof Error ? reason.stack : msg}`);
  });

  const role = config.nodeRole ?? 'edge';

  const banner = `
██████╗ ███████╗ ██████╗███████╗███╗   ██╗████████╗██████╗  █████╗ ██╗     ██╗███████╗███████╗██████╗ 
██╔══██╗██╔════╝██╔════╝██╔════╝████╗  ██║╚══██╔══╝██╔══██╗██╔══██╗██║     ██║╚══███╔╝██╔════╝██╔══██╗
██║  ██║█████╗  ██║     █████╗  ██╔██╗ ██║   ██║   ██████╔╝███████║██║     ██║  ███╔╝ █████╗  ██║  ██║
██║  ██║██╔══╝  ██║     ██╔══╝  ██║╚██╗██║   ██║   ██╔══██╗██╔══██║██║     ██║ ███╔╝  ██╔══╝  ██║  ██║
██████╔╝███████╗╚██████╗███████╗██║ ╚████║   ██║   ██║  ██║██║  ██║███████╗██║███████╗███████╗██████╔╝
╚═════╝ ╚══════╝ ╚═════╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝╚══════╝╚══════╝╚═════╝ 

██╗  ██╗███╗   ██╗ ██████╗ ██╗    ██╗██╗     ███████╗██████╗  ██████╗ ███████╗
██║ ██╔╝████╗  ██║██╔═══██╗██║    ██║██║     ██╔════╝██╔══██╗██╔════╝ ██╔════╝
█████╔╝ ██╔██╗ ██║██║   ██║██║ █╗ ██║██║     █████╗  ██║  ██║██║  ███╗█████╗
██╔═██╗ ██║╚██╗██║██║   ██║██║███╗██║██║     ██╔══╝  ██║  ██║██║   ██║██╔══╝
██║  ██╗██║ ╚████║╚██████╔╝╚███╔███╔╝███████╗███████╗██████╔╝╚██████╔╝███████╗
╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚══╝╚══╝ ╚══════╝╚══════╝╚═════╝  ╚═════╝ ╚══════╝

 ██████╗ ██████╗  █████╗ ██████╗ ██╗  ██╗              ██████╗ ██╗  ██╗ ██████╗     ██╗   ██╗ █████╗ 
██╔════╝ ██╔══██╗██╔══██╗██╔══██╗██║  ██║              ██╔══██╗██║ ██╔╝██╔════╝     ██║   ██║██╔══██╗
██║  ███╗██████╔╝███████║██████╔╝███████║    █████╗    ██║  ██║█████╔╝ ██║  ███╗    ██║   ██║╚██████║
██║   ██║██╔══██╗██╔══██║██╔═══╝ ██╔══██║    ╚════╝    ██║  ██║██╔═██╗ ██║   ██║    ╚██╗ ██╔╝ ╚═══██║
╚██████╔╝██║  ██║██║  ██║██║     ██║  ██║              ██████╔╝██║  ██╗╚██████╔╝     ╚████╔╝  █████╔╝
 ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝              ╚═════╝ ╚═╝  ╚═╝ ╚═════╝       ╚═══╝   ╚════╝
`;
  origStdoutWrite(banner + '\n');
  appendFile(logFile, banner + '\n').catch(() => {});

  const nodeVersion = getNodeVersion();
  const nodeCommit = getCurrentCommitShort(); // cached once at startup — avoids execSync in hot path
  const versionTag = nodeCommit ? `v${nodeVersion}, ${nodeCommit}` : `v${nodeVersion}`;
  log(`Starting DKG ${role} node "${config.name}" (${versionTag})...`);

  const network = await loadNetworkConfig();
  const syncContextGraphs = [...new Set([
    ...resolveContextGraphs(config),
    ...resolveNetworkDefaultContextGraphs(network),
  ])];

  // Load operational wallets from ~/.dkg/wallets.json (auto-generated on first run)
  const opWallets = await loadOpWallets(dkgDir());
  log(`Operational wallets (${opWallets.wallets.length}):`);
  for (const w of opWallets.wallets) {
    log(`  ${w.address}`);
  }

  // Build chain config from CLI config or network config
  const chainBase = config.chain ?? network?.chain;

  // Relay: prefer config.relay, fall back to network testnet.json relays so
  // local nodes connect without having run init or set relay manually.
  // "none" disables relay entirely (used by devnet relay nodes to prevent
  // cross-network leakage into testnet).
  let relayPeers: string[] | undefined;
  if (config.relay === 'none') {
    relayPeers = undefined;
    log('Relay disabled (config.relay = "none") — this node will not connect to any relay');
  } else if (config.relay) {
    relayPeers = [config.relay];
  } else if (network?.relays?.length) {
    relayPeers = network.relays;
    log(`Using relay(s) from network config (${network.networkName})`);
  }
  if (!relayPeers?.length && !config.bootstrapPeers?.length && config.relay !== 'none') {
    log('No relay or bootstrap peers configured. Set "relay" or "bootstrapPeers" in ~/.dkg/config.json or run from repo so network/testnet.json is found.');
  }

  const agent = await DKGAgent.create({
    name: config.name,
    framework: 'DKG',
    listenPort: config.listenPort,
    dataDir: dkgDir(),
    bootstrapPeers: config.bootstrapPeers,
    relayPeers,
    announceAddresses: config.announceAddresses,
    nodeRole: role,
    syncContextGraphs: syncContextGraphs,
    storeConfig: config.store ? {
      backend: config.store.backend,
      options: config.store.options,
    } : undefined,
    chainConfig: chainBase ? {
      rpcUrl: chainBase.rpcUrl,
      hubAddress: chainBase.hubAddress,
      operationalKeys: opWallets.wallets.map((w) => w.privateKey),
      chainId: chainBase.chainId,
    } : undefined,
    sharedMemoryTtlMs: resolveSharedMemoryTtlMs(config),
  });

  let publisherRuntime: PublisherRuntime | null = null;

  const networkId = await computeNetworkId();
  const publisherControl = createPublisherControlFromStore(agent.store);
  log(`Network: ${networkId.slice(0, 16)}...`);
  if (network?.networkId && network.networkId !== networkId) {
    log(`FATAL: genesis mismatch! Expected networkId ${network.networkId.slice(0, 16)}... but computed ${networkId.slice(0, 16)}...`);
    log(`This node's genesis does not match network/testnet.json. Rebuild or update the repo.`);
    process.exit(1);
  }
  if (network) {
    log(`Network config: ${network.networkName} (genesis v${network.genesisVersion})`);
  }

  let chatDb: DashboardDB | null = null;
  agent.onChat((text, senderPeerId, _convId) => {
    if (chatDb) {
      try { chatDb.insertChatMessage({ ts: Date.now(), direction: 'in', peer: senderPeerId, text }); } catch { /* never crash */ }
      try {
        chatDb.insertNotification({
          ts: Date.now(),
          type: 'chat_message',
          title: 'New message',
          message: `Message from ${shortId(senderPeerId)}: ${text.slice(0, 120)}`,
          source: 'peer-chat',
          peer: senderPeerId,
        });
      } catch { /* never crash */ }
    }
    log(`CHAT IN  [${shortId(senderPeerId)}]: ${text}`);
  });

  await agent.start();
  await agent.publishProfile();

  publisherRuntime = await startPublisherRuntimeIfEnabled({
    dataDir: dkgDir(),
    config,
    store: agent.store,
    keypair: agent.wallet.keypair,
    chainBase,
    ackTransportFactory: () => ({
      publisherPeerId: agent.peerId,
      gossipPublish: async (topic: string, data: Uint8Array) => {
        await agent.gossip.publish(topic, data);
      },
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => {
        return agent.router.send(peerId, protocol, data);
      },
      getConnectedCorePeers: () => {
        const allPeers = agent.node.libp2p.getPeers().map((p) => p.toString()).filter((id) => id !== agent.peerId);
        const knownCorePeerIds = (agent as any).knownCorePeerIds as Set<string> | undefined;
        if (knownCorePeerIds && knownCorePeerIds.size > 0) {
          const filtered = allPeers.filter((id) => knownCorePeerIds.has(id));
          if (filtered.length > 0) return filtered;
        }
        return allPeers;
      },
      log,
    }),
    log,
  });

  log(`PeerId: ${agent.peerId}`);
  for (const a of agent.multiaddrs) log(`  ${a}`);

  if (relayPeers?.length) {
    log(`Relay: ${relayPeers[0]}${relayPeers.length > 1 ? ` (+${relayPeers.length - 1} more)` : ''}`);
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      const circuitAddrs = agent.multiaddrs.filter(a => a.includes('/p2p-circuit/'));
      if (circuitAddrs.length) {
        log(`Circuit reservation granted (${circuitAddrs.length} addresses)`);
        break;
      }
      if (i === 9) log('WARNING: no circuit addresses after 10s');
    }
  }

  // Ensure configured context graphs + network defaults are subscribed and available.
  // Uses ensureParanetLocal (idempotent) to avoid duplicate creator claims
  // and to survive "already exists" gracefully.
  const contextGraphsToSubscribe = new Set(syncContextGraphs);
  for (const p of contextGraphsToSubscribe) {
    try {
      await agent.ensureContextGraphLocal({
        id: p,
        name: p,
        description: `Default context graph: ${p}`,
      });
      log(`Ensured context graph: ${p}`);
    } catch (err) {
      log(`Context graph "${p}" setup failed: ${err instanceof Error ? err.message : String(err)} — will discover via sync/gossip`);
      agent.subscribeToContextGraph(p);
    }
  }

  // Run an initial chain scan for context graphs we might not know about,
  // then repeat every 30 minutes as a fallback discovery mechanism.
  const CHAIN_SCAN_INTERVAL_MS = 30 * 60 * 1000;
  setTimeout(async () => {
    try {
      const found = await agent.discoverContextGraphsFromChain();
      if (found > 0) log(`Chain scan: discovered ${found} new context graph(s)`);
    } catch { /* non-critical */ }
  }, 15_000);
  const chainScanTimer = setInterval(async () => {
    try {
      const found = await agent.discoverContextGraphsFromChain();
      if (found > 0) log(`Chain scan: discovered ${found} new context graph(s)`);
    } catch { /* non-critical */ }
  }, CHAIN_SCAN_INTERVAL_MS);
  if (chainScanTimer.unref) chainScanTimer.unref();

  // Periodic peer health ping (every 2 minutes)
  const PING_INTERVAL_MS = 2 * 60 * 1000;
  setTimeout(async () => {
    try { await agent.pingPeers(); } catch { /* non-critical */ }
  }, 30_000);
  const pingTimer = setInterval(async () => {
    try { await agent.pingPeers(); } catch { /* non-critical */ }
  }, PING_INTERVAL_MS);
  if (pingTimer.unref) pingTimer.unref();

  // Version check + auto-update
  let updateInterval: ReturnType<typeof setInterval> | null = null;
  const au = config.autoUpdate;
  const standalone = isStandaloneInstall();
  const hasGitConfig = !!(au?.repo && au?.branch);

  if (standalone || hasGitConfig) {
    const checkIntervalMs = (au?.checkIntervalMinutes || 30) * 60_000;
    const allowPre = au?.allowPrerelease ?? true;

    if (standalone) {
      log(`Auto-update (npm): ${au?.enabled !== false ? 'enabled' : 'disabled — version check only'} (every ${au?.checkIntervalMinutes ?? 30}min)`);
    } else if (hasGitConfig) {
      log(`Auto-update ${au!.enabled ? 'enabled' : 'disabled — version check only'}: ${au!.repo}@${au!.branch} (every ${au!.checkIntervalMinutes}min)`);
    }

    const runCheck = async () => {
      let updateAvailable = false;
      let targetNpmVersion = '';

      if (standalone) {
        const npmStatus = await checkForNpmVersionUpdate(log, allowPre);
        if (npmStatus.status !== 'error') {
          lastUpdateCheck.upToDate = npmStatus.status === 'up-to-date';
          lastUpdateCheck.checkedAt = Date.now();
          if (npmStatus.version) lastUpdateCheck.latestVersion = npmStatus.version;
        }
        if (npmStatus.status === 'available' && npmStatus.version) {
          updateAvailable = true;
          targetNpmVersion = npmStatus.version;
        }
      } else if (hasGitConfig) {
        const commitStatus = await checkForNewCommitWithStatus(au!, log);
        if (commitStatus.status !== 'error') {
          lastUpdateCheck.upToDate = commitStatus.status === 'up-to-date';
          lastUpdateCheck.checkedAt = Date.now();
          if (commitStatus.commit) lastUpdateCheck.latestCommit = commitStatus.commit.slice(0, 8);
        }
        updateAvailable = commitStatus.status === 'available';
      }

      if ((au?.enabled !== false) && updateAvailable) {
        isUpdating = true;
        let updated = false;
        if (standalone && targetNpmVersion) {
          const status = await performNpmUpdate(targetNpmVersion, log);
          updated = status === 'updated';
        } else if (hasGitConfig) {
          updated = await checkForUpdate(au!, log);
        }
        isUpdating = false;
        if (updated) {
          log('Auto-update: update activated; exiting for supervised restart.');
          await shutdown(DAEMON_EXIT_CODE_RESTART);
          return;
        }
      }
    };

    setTimeout(runCheck, 15_000);
    updateInterval = setInterval(runCheck, checkIntervalMs);
  }

  // --- Dashboard DB + Metrics ---

  const dashDb = new DashboardDB({ dataDir: dkgDir() });
  chatDb = dashDb;
  log('Dashboard DB initialized at ' + join(dkgDir(), 'node-ui.db'));

  Logger.setSink((entry) => {
    try {
      dashDb.insertLog({
        ts: Date.now(),
        level: entry.level,
        operation_name: entry.operationName,
        operation_id: entry.operationId,
        module: entry.module,
        message: entry.message,
      });
    } catch { /* DB write must never break the node */ }
    logPusher?.push(entry);
  });

  // Extract the plain value from an RDF typed literal like "6"^^<xsd:integer>
  function parseRdfInt(raw: string | undefined): number {
    if (!raw) return 0;
    const m = raw.match(/^"?(\d+)"?\^?\^/);
    if (m) return parseInt(m[1], 10);
    const n = parseInt(raw, 10);
    return isNaN(n) ? 0 : n;
  }

  const metricsSource: MetricsSource = {
    getPeerCount: () => new Set(agent.node.libp2p.getConnections().map(c => c.remotePeer.toString())).size,
    getDirectPeerCount: () => new Set(agent.node.libp2p.getConnections().filter(c => !c.remoteAddr?.toString().includes('/p2p-circuit')).map(c => c.remotePeer.toString())).size,
    getRelayedPeerCount: () => new Set(agent.node.libp2p.getConnections().filter(c => c.remoteAddr?.toString().includes('/p2p-circuit')).map(c => c.remotePeer.toString())).size,
    getMeshPeerCount: () => {
      try { return (agent.gossip as any).gossipsub?.getMeshPeers?.()?.length ?? 0; } catch { return 0; }
    },
    getContextGraphCount: async () => (await agent.listContextGraphs()).length,
    getTotalTriples: async () => {
      const r = await agent.query('SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }');
      return parseRdfInt(r?.bindings?.[0]?.c);
    },
    getTotalKCs: async () => {
      const r = await agent.query('SELECT (COUNT(DISTINCT ?kc) AS ?c) WHERE { GRAPH ?g { ?kc a <http://dkg.io/ontology/KnowledgeCollection> } }');
      return parseRdfInt(r?.bindings?.[0]?.c);
    },
    getTotalKAs: async () => {
      const r = await agent.query('SELECT (COUNT(DISTINCT ?ka) AS ?c) WHERE { GRAPH ?g { ?ka a <http://dkg.io/ontology/KnowledgeAsset> } }');
      return parseRdfInt(r?.bindings?.[0]?.c);
    },
    getConfirmedKCs: async () => {
      const r = await agent.query('SELECT (COUNT(DISTINCT ?kc) AS ?c) WHERE { GRAPH ?g { ?kc <http://dkg.io/ontology/status> "confirmed" } }');
      return parseRdfInt(r?.bindings?.[0]?.c);
    },
    getTentativeKCs: async () => {
      const r = await agent.query('SELECT (COUNT(DISTINCT ?kc) AS ?c) WHERE { GRAPH ?g { ?kc <http://dkg.io/ontology/status> "tentative" } }');
      return parseRdfInt(r?.bindings?.[0]?.c);
    },
    getStoreBytes: async () => {
      try {
        const s = await stat(join(dkgDir(), 'store.nq'));
        return s.size;
      } catch { return 0; }
    },
    getRpcLatencyMs: async () => 0,
    isRpcHealthy: async () => true,
  };

  const metricsCollector = new MetricsCollector(dashDb, metricsSource, dkgDir());
  metricsCollector.start();
  log('Metrics collector started (2min interval)');

  // --- Telemetry: syslog log streaming (opt-in) ---
  const networkKey = network?.networkName?.toLowerCase().includes('testnet') ? 'testnet' : 'mainnet';
  const syslogEndpoint = TELEMETRY_ENDPOINTS[networkKey]?.syslog;
  let logPusher: LogPushWorker | null = null;

  function startLogPusher(): { ok: boolean; error?: string } {
    if (logPusher) return { ok: true };
    if (!syslogEndpoint || !syslogEndpoint.port) {
      return { ok: false, error: `Telemetry streaming is not available for ${networkKey} (no syslog endpoint configured)` };
    }
    const autoUpdateEnabled = config.autoUpdate?.enabled ?? false;
    logPusher = new LogPushWorker({
      host: syslogEndpoint.host,
      port: syslogEndpoint.port,
      peerId: agent.peerId,
      network: networkKey,
      nodeName: config.name,
      version: nodeVersion,
      commit: nodeCommit,
      role: config.nodeRole ?? 'edge',
      autoUpdate: autoUpdateEnabled,
      versionStatus: () => {
        if (!autoUpdateEnabled) return 'disabled';
        if (isUpdating) return 'updating';
        if (lastUpdateCheck.checkedAt === 0) return 'unknown';
        return lastUpdateCheck.upToDate ? 'latest' : 'behind';
      },
    });
    logPusher.start();
    log(`Telemetry: log streaming enabled → ${syslogEndpoint.host}:${syslogEndpoint.port}`);
    return { ok: true };
  }

  function stopLogPusher(): void {
    if (!logPusher) return;
    logPusher.stop();
    logPusher = null;
    log('Telemetry: log streaming disabled');
  }

  if (config.telemetry?.enabled) {
    const r = startLogPusher();
    if (!r.ok) {
      log(`Telemetry: ${r.error}`);
      config.telemetry.enabled = false;
    }
  }

  const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MB
  const PRUNE_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours
  const pruneTimer = setInterval(async () => {
    try {
      dashDb.prune();
      const st = await stat(logFile).catch(() => null);
      if (st && st.size > MAX_LOG_BYTES) {
        const tail = await readFile(logFile, 'utf8');
        const keepFrom = tail.length - Math.floor(MAX_LOG_BYTES * 0.7);
        const newlineIdx = tail.indexOf('\n', keepFrom);
        if (newlineIdx > 0) {
          await writeFile(logFile, tail.slice(newlineIdx + 1));
        } else {
          await writeFile(logFile, tail.slice(keepFrom));
        }
        log(`Rotated daemon.log (was ${(st.size / 1024 / 1024).toFixed(1)} MB)`);
      }
    } catch { /* never crash the daemon */ }
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const tracker = new OperationTracker(dashDb);

  // Track peer connections
  agent.eventBus.on(DKGEvent.CONNECTION_OPEN, (data: any) => {
    const ctx = createOperationContext('connect');
    tracker.start(ctx, { peerId: data.peerId });
    tracker.complete(ctx, { details: { transport: data.transport, direction: data.direction } });
  });

  // Notify on new peer connections
  agent.eventBus.on(DKGEvent.PEER_CONNECTED, (data: any) => {
    try {
      dashDb.insertNotification({
        ts: Date.now(),
        type: 'peer_connected',
        title: 'Peer connected',
        message: `Peer ${shortId(data.peerId)} connected`,
        source: 'network',
        peer: data.peerId,
      });
    } catch { /* never crash */ }
  });

  agent.eventBus.on(DKGEvent.PEER_DISCONNECTED, (data: any) => {
    try {
      dashDb.insertNotification({
        ts: Date.now(),
        type: 'peer_disconnected',
        title: 'Peer disconnected',
        message: `Peer ${shortId(data.peerId)} disconnected`,
        source: 'network',
        peer: data.peerId,
      });
    } catch { /* never crash */ }
  });

  // Track publishes via KC_PUBLISHED event (covers GossipSub-received publishes)
  agent.eventBus.on(DKGEvent.KC_PUBLISHED, (data: any) => {
    const ctx = createOperationContext('publish');
    tracker.start(ctx, { contextGraphId: data.paranetId, details: { kcId: data.kcId, source: 'gossipsub' } });
    tracker.complete(ctx, { tripleCount: data.tripleCount });
    try {
      dashDb.insertNotification({
        ts: Date.now(),
        type: 'kc_published',
        title: 'Knowledge published',
        message: `Knowledge collection published${data.paranetId ? ` on context graph ${shortId(data.paranetId)}` : ''}`,
        source: 'dkg',
        meta: JSON.stringify({ kcId: data.kcId, contextGraphId: data.paranetId }),
      });
    } catch { /* never crash */ }
  });

  const agentToolsContext = {
    query: (sparql: string, opts?: { contextGraphId?: string; graphSuffix?: '_shared_memory'; includeSharedMemory?: boolean }) => agent.query(sparql, opts),
    share: (contextGraphId: string, quads: any[], opts?: { localOnly?: boolean }) => agent.share(contextGraphId, quads, opts),
    publishFromSharedMemory: (contextGraphId: string, selection: 'all' | { rootEntities: string[] }, opts?: { clearSharedMemoryAfter?: boolean }) => agent.publishFromSharedMemory(contextGraphId, selection, opts),
    createContextGraph: (opts: { id: string; name: string; description?: string; private?: boolean }) => agent.createContextGraph(opts),
    listContextGraphs: () => agent.listContextGraphs(),
  };
  const chatAssistant = new ChatAssistant(
    dashDb,
    async (sparql: string) => agent.query(sparql),
    config.llm,
    agentToolsContext,
  );
  const memoryManager = new ChatMemoryManager(agentToolsContext, config.llm ?? { apiKey: '' });
  log('Memory manager ready');
  if (config.llm) log('Chat assistant ready (LLM + DKG tools enabled)');
  else log('Chat assistant ready');

  const llmSettings = {
    getLlm: () => config.llm,
    setLlm: async (llm: { apiKey: string; model?: string; baseURL?: string } | null) => {
      if (llm) {
        config.llm = llm;
        chatAssistant.updateLlmConfig(llm);
        memoryManager.updateConfig(llm);
        log('LLM config updated via settings');
      } else {
        delete config.llm;
        chatAssistant.updateLlmConfig(undefined);
        memoryManager.updateConfig({ apiKey: '' });
        log('LLM config cleared via settings');
      }
      await saveConfig(config);
    },
  };

  const telemetrySettings = {
    getTelemetryEnabled: () => config.telemetry?.enabled ?? false,
    setTelemetryEnabled: async (enabled: boolean): Promise<{ ok: boolean; error?: string }> => {
      if (enabled) {
        const r = startLogPusher();
        if (!r.ok) return r;
      } else {
        stopLogPusher();
      }
      config.telemetry = { ...config.telemetry, enabled };
      await saveConfig(config);
      return { ok: true };
    },
  };

  // Resolve the static UI directory (built by @origintrail-official/dkg-node-ui)
  let nodeUiStaticDir: string;
  try {
    const nodeUiPkg = import.meta.resolve('@origintrail-official/dkg-node-ui');
    const nodeUiDir = dirname(fileURLToPath(nodeUiPkg));
    nodeUiStaticDir = join(nodeUiDir, '..', 'dist-ui');
  } catch {
    const root = repoDir();
    nodeUiStaticDir = root
      ? join(root, 'packages', 'node-ui', 'dist-ui')
      : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node-ui', 'dist-ui');
  }

  // --- Authentication ---

  const authEnabled = config.auth?.enabled !== false;
  const validTokens = await loadTokens(config.auth);
  const bridgeAuthToken = await loadBridgeAuthToken()
    ?? (validTokens.size > 0 ? (validTokens.values().next().value as string) : undefined);
  if (authEnabled) {
    log(`API authentication enabled (${validTokens.size} token${validTokens.size !== 1 ? 's' : ''} loaded)`);
    log(`Token file: ${join(dkgDir(), 'auth.token')}`);
  } else {
    log('API authentication disabled (auth.enabled = false)');
  }

  // --- Installable Apps ---

  const installedApps: LoadedApp[] = await loadApps(agent, config, log);
  let appStaticPort: number | undefined;
  let appStaticServer: import('node:http').Server | undefined;
  const apiPortRef = { value: 0 };
  if (installedApps.length > 0) {
    log(`${installedApps.length} DKG app(s) loaded: ${installedApps.map(a => a.label).join(', ')}`);
    const appHost = config.apiHost || '127.0.0.1';
    let desiredAppPort = (config.apiPort || 19200) + 100;
    if (config.listenPort && desiredAppPort === config.listenPort) {
      desiredAppPort = config.listenPort + 1;
      log(`App static port would collide with libp2p listenPort ${config.listenPort}, using ${desiredAppPort}`);
    }
    try {
      const boundToLoopback = appHost === '127.0.0.1' || appHost === '::1';
      const firstToken = validTokens.size > 0 ? validTokens.values().next().value as string : undefined;
      const appAuthTokenRef = boundToLoopback && authEnabled ? { value: firstToken } : undefined;
      const result = await startAppStaticServer(installedApps, appHost, desiredAppPort, apiPortRef, log, appAuthTokenRef);
      appStaticServer = result.server;
      appStaticPort = result.port;
    } catch (err: any) {
      log(`App static server failed to start: ${err.message}. Apps will be served from main server.`);
    }
  }

  const catchupTracker: CatchupTracker = {
    jobs: new Map(),
    latestByParanet: new Map(),
  };

  // --- Extraction Pipelines ---

  const extractionRegistry = new ExtractionPipelineRegistry();
  if (isMarkItDownAvailable()) {
    extractionRegistry.register(new MarkItDownConverter());
  }
  // text/markdown is always natively handled by the import-file route
  // regardless of converter registration; report the full effective set so
  // operators see the same list that /.well-known/skill.md advertises.
  const supportedIngestionTypes = [
    ...new Set(['text/markdown', ...extractionRegistry.availableContentTypes()]),
  ];
  log(`Extraction pipelines: ${supportedIngestionTypes.join(', ')}`);
  if (!isMarkItDownAvailable()) {
    log('MarkItDown binary not found — non-markdown document extraction unavailable (files stored as blobs)');
  }

  // --- File Store ---

  const fileStore = new FileStore(join(dkgDir(), 'files'));

  // In-memory extraction job status tracker. Synchronous extractions (the V10.0
  // default) populate this with a completed record on the same request; async
  // workflows can be layered later without changing the endpoint contract.
  const extractionStatus = new Map<string, ExtractionStatusRecord>();

  // Round 6 Bug 19: per-assertion mutex for the import-file snapshot+
  // insert+rollback sequence. Without this, concurrent imports of the
  // SAME assertion URI race: request A commits, request B (which
  // snapshotted the older state) fails, B's rollback then re-inserts
  // its stale snapshot and silently wipes A's successful commit.
  //
  // Lock scope is the full snapshot → cleanup → atomic insert →
  // rollback critical section. Imports of DIFFERENT assertion URIs
  // run in parallel — the lock is per-URI.
  //
  // CAVEAT: single-process lock only. Multi-daemon deployments sharing
  // a triple store need storage-layer optimistic concurrency control
  // (version counters or ETag-like compare-and-swap) to close the race
  // across processes — out of scope for Round 6.
  const assertionImportLocks = new Map<string, Promise<void>>();

  // --- HTTP API ---

  const rateLimiter = new HttpRateLimiter(
    config.rateLimit?.requestsPerMinute ?? 120,
    config.rateLimit?.exempt ?? ['/api/status', '/api/chain/rpc-health', '/.well-known/skill.md'],
  );
  let corsAllowed: CorsAllowlist = '*';

  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host}`);

      // Resolve CORS origin once per request (request-scoped, not global)
      const reqCorsOrigin = resolveCorsOrigin(req, corsAllowed) ?? null;
      (res as any).__corsOrigin = reqCorsOrigin;

      // Rate limiting — include CORS headers so browsers surface 429 instead of opaque CORS failure
      const clientIp = req.socket.remoteAddress ?? 'unknown';
      if (!rateLimiter.isAllowed(clientIp, reqUrl.pathname)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60', ...corsHeaders(reqCorsOrigin) });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }

      // CORS preflight
      if (req.method === 'OPTIONS') {
        if (!reqCorsOrigin && corsAllowed !== '*') {
          res.writeHead(403).end();
          return;
        }
        res.writeHead(204, {
          ...(reqCorsOrigin ? { 'Access-Control-Allow-Origin': reqCorsOrigin } : {}),
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
      }

      // Auth guard — rejects with 401 if token is invalid/missing
      if (!httpAuthGuard(req, res, authEnabled, validTokens, resolveCorsOrigin(req, corsAllowed))) return;

      // Shared memory (workspace) TTL settings — V10 and legacy routes
      if (req.method === 'GET' && (reqUrl.pathname === '/api/settings/shared-memory-ttl' || reqUrl.pathname === '/api/settings/workspace-ttl')) {
        const ttlMs = resolveSharedMemoryTtlMs(config) ?? 30 * 24 * 60 * 60 * 1000;
        return jsonResponse(res, 200, { ttlMs, ttlDays: Math.round(ttlMs / (24 * 60 * 60 * 1000)) });
      }
      if (req.method === 'PUT' && (reqUrl.pathname === '/api/settings/shared-memory-ttl' || reqUrl.pathname === '/api/settings/workspace-ttl')) {
        try {
          const bodyStr = await readBody(req, SMALL_BODY_BYTES);
          const { ttlDays } = JSON.parse(bodyStr ?? '{}') as { ttlDays?: number };
          if (typeof ttlDays !== 'number' || !Number.isFinite(ttlDays) || ttlDays < 0) {
            return jsonResponse(res, 400, { error: 'ttlDays must be a finite non-negative number' });
          }
          const ttlMs = Math.round(ttlDays * 24 * 60 * 60 * 1000);
          config.sharedMemoryTtlMs = ttlMs;
          config.workspaceTtlMs = ttlMs;
          agent.setSharedMemoryTtlMs(ttlMs);
          await saveConfig(config);
          return jsonResponse(res, 200, { ok: true, ttlMs, ttlDays });
        } catch (err: any) {
          if (err instanceof PayloadTooLargeError) throw err;
          return jsonResponse(res, 500, { error: err.message ?? 'Failed to update shared memory TTL' });
        }
      }

      // Node UI routes (metrics, operations, logs, saved queries, chat, static UI)
      const firstToken = validTokens.size > 0 ? validTokens.values().next().value as string : undefined;
      const handled = await handleNodeUIRequest(req, res, reqUrl, dashDb, nodeUiStaticDir, chatAssistant, metricsCollector, authEnabled ? firstToken : undefined, memoryManager, llmSettings, telemetrySettings, resolveCorsOrigin(req, corsAllowed));
      if (handled) return;

      // Installable DKG apps (API handlers + static UI)
      // Always call handleAppRequest so GET /api/apps returns [] when no apps are installed.
      // Inject the caller's verified token if present; for loopback-bound servers,
      // fall back to the first stored token for /apps/* HTML requests only —
      // TCP binding guarantees only local connections reach loopback sockets.
      let appInjectToken: string | undefined;
      if (installedApps.length > 0 && authEnabled && validTokens.size > 0) {
        const reqToken = extractBearerToken(req.headers.authorization);
        if (reqToken && validTokens.has(reqToken)) {
          appInjectToken = reqToken;
        } else if (reqUrl.pathname.startsWith('/apps/')) {
          const boundHost = config.apiHost || '127.0.0.1';
          const boundToLoopback = boundHost === '127.0.0.1' || boundHost === '::1';
          if (boundToLoopback) {
            appInjectToken = validTokens.values().next().value as string;
          }
        }
      }
      const appHandled = await handleAppRequest(req, res, reqUrl, installedApps, appInjectToken, appStaticPort);
      if (appHandled) return;

      await handleRequest(
        req,
        res,
        agent,
        publisherControl,
        config,
        startedAt,
        dashDb,
        opWallets,
        network,
        tracker,
        memoryManager,
        bridgeAuthToken,
        nodeVersion,
        nodeCommit,
        catchupTracker,
        extractionRegistry,
        fileStore,
        extractionStatus,
      );
    } catch (err: any) {
      if (res.headersSent || res.writableEnded) return;
      if (err instanceof PayloadTooLargeError) {
        jsonResponse(res, 413, { error: err.message });
      } else if (err instanceof SyntaxError) {
        jsonResponse(res, 400, { error: err.message });
      } else if (
        // Round 9 Bug 25: user-authored quads with reserved URN prefixes
        // map to 400 at the top-level catch so share/publish/conditionalShare
        // routes (which rethrow for the top-level handler) get the correct
        // status without each route having to match on the error shape.
        err?.name === 'ReservedNamespaceError'
        || (typeof err?.message === 'string' && err.message.includes('reserved namespace'))
      ) {
        jsonResponse(res, 400, { error: err.message });
      } else {
        jsonResponse(res, 500, { error: err.message });
      }
    }
  });

  const apiPort = config.apiPort || 0;
  const apiHost = config.apiHost || '127.0.0.1';
  await new Promise<void>((resolve) => {
    server.listen(apiPort, apiHost, () => resolve());
  });
  const boundPort = (server.address() as any).port as number;
  apiPortRef.value = boundPort;
  await writeApiPort(boundPort);

  corsAllowed = buildCorsAllowlist(config, boundPort);
  _moduleCorsAllowed = corsAllowed;
  if (corsAllowed !== '*') {
    log(`CORS allowlist: ${corsAllowed.join(', ')}`);
  }

  log(`API listening on http://${apiHost}:${boundPort}`);
  log(`Node UI: http://${apiHost}:${boundPort}/ui`);
  log('Node is running. Use "dkg status" or "dkg peers" to interact.');

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down...');
    if (updateInterval) clearInterval(updateInterval);
    clearInterval(chainScanTimer);
    clearInterval(pingTimer);
    clearInterval(pruneTimer);
    rateLimiter.destroy();
    await Promise.allSettled(installedApps.map(async (app) => {
      if (!app.destroy) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5_000); });
        await Promise.race([app.destroy(), timeout]);
      } catch (err: any) { log(`App ${app.id} destroy error: ${err.message}`); }
      finally { if (timer) clearTimeout(timer); }
    }));
    metricsCollector.stop();
    await publisherRuntime?.stop().catch((err: any) => log(`Publisher runtime stop error: ${err?.message ?? String(err)}`));
    server.close();
    appStaticServer?.close();
    await agent.stop();
    dashDb.close();
    await removePid();
    await removeApiPort();
    log('Stopped.');
    process.exit(exitCode);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

let _moduleCorsAllowed: CorsAllowlist = '*';

// OpenClaw bridge health cache — avoids hammering the bridge on every /send
let bridgeHealthCache: { ok: boolean; ts: number } | null = null;
const HEALTH_CACHE_TTL = 10_000; // 10 seconds

export interface OpenClawChannelTarget {
  name: 'bridge' | 'gateway';
  inboundUrl: string;
  streamUrl?: string;
  healthUrl?: string;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function buildOpenClawGatewayBase(value: string): string {
  return value.endsWith('/api/dkg-channel') ? value : `${value}/api/dkg-channel`;
}

async function loadBridgeAuthToken(): Promise<string | undefined> {
  try {
    const raw = await readFile(join(dkgDir(), 'auth.token'), 'utf-8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return undefined;
  }
}

export function getOpenClawChannelTargets(config: DkgConfig): OpenClawChannelTarget[] {
  const openclawChannel = config.openclawChannel ?? {};
  const explicitBridgeBase = openclawChannel.bridgeUrl
    ? trimTrailingSlashes(openclawChannel.bridgeUrl)
    : undefined;
  const explicitGatewayBase = openclawChannel.gatewayUrl
    ? trimTrailingSlashes(openclawChannel.gatewayUrl)
    : undefined;
  const bridgeLooksLikeGateway = explicitBridgeBase?.endsWith('/api/dkg-channel') ?? false;
  const standaloneBridgeBase = explicitBridgeBase
    ? (bridgeLooksLikeGateway ? undefined : explicitBridgeBase)
    : (!explicitGatewayBase ? 'http://127.0.0.1:9201' : undefined);
  const gatewayBase = explicitGatewayBase ?? (bridgeLooksLikeGateway ? explicitBridgeBase : undefined);
  const targets: OpenClawChannelTarget[] = [];
  const seenInboundUrls = new Set<string>();

  const pushTarget = (target: OpenClawChannelTarget) => {
    if (seenInboundUrls.has(target.inboundUrl)) return;
    seenInboundUrls.add(target.inboundUrl);
    targets.push(target);
  };

  if (standaloneBridgeBase) {
    pushTarget({
      name: 'bridge',
      inboundUrl: `${standaloneBridgeBase}/inbound`,
      streamUrl: `${standaloneBridgeBase}/inbound/stream`,
      healthUrl: `${standaloneBridgeBase}/health`,
    });
  }

  if (gatewayBase) {
    const normalizedGatewayBase = buildOpenClawGatewayBase(gatewayBase);
    pushTarget({
      name: 'gateway',
      inboundUrl: `${normalizedGatewayBase}/inbound`,
      healthUrl: `${normalizedGatewayBase}/health`,
    });
  }

  return targets;
}

function shouldTryNextOpenClawTarget(status: number): boolean {
  return status === 404 || status === 405 || status === 501 || status === 503;
}

export function buildOpenClawChannelHeaders(
  target: OpenClawChannelTarget,
  bridgeAuthToken: string | undefined,
  baseHeaders: Record<string, string> = {},
): Record<string, string> {
  if (target.name !== 'bridge' || !bridgeAuthToken) return baseHeaders;
  return { ...baseHeaders, 'x-dkg-bridge-token': bridgeAuthToken };
}

async function ensureOpenClawBridgeAvailable(
  target: OpenClawChannelTarget,
  bridgeAuthToken: string | undefined,
): Promise<{ ok: boolean; status?: number; details?: string; offline?: boolean }> {
  if (target.name !== 'bridge' || !target.healthUrl) return { ok: true };
  if (!bridgeAuthToken) {
    return { ok: false, details: 'Bridge auth token unavailable', offline: true };
  }

  const cachedBridgeHealth = bridgeHealthCache;
  const cacheValid = cachedBridgeHealth !== null && (Date.now() - cachedBridgeHealth.ts < HEALTH_CACHE_TTL);
  if (cacheValid) {
    return cachedBridgeHealth.ok
      ? { ok: true }
      : { ok: false, details: 'Bridge health check cached as unavailable', offline: true };
  }

  try {
    const healthRes = await fetch(target.healthUrl, {
      headers: buildOpenClawChannelHeaders(target, bridgeAuthToken, { Accept: 'application/json' }),
      signal: AbortSignal.timeout(3_000),
    });
    bridgeHealthCache = { ok: healthRes.ok, ts: Date.now() };
    if (!healthRes.ok) {
      const details = await healthRes.text().catch(() => '');
      return {
        ok: false,
        status: healthRes.status,
        details: details || `Bridge health responded ${healthRes.status}`,
        offline: true,
      };
    }
    return { ok: true };
  } catch (err: any) {
    bridgeHealthCache = { ok: false, ts: Date.now() };
    return { ok: false, details: err.message, offline: true };
  }
}

type OpenClawStreamRequest = Pick<IncomingMessage, 'on'>;
type OpenClawStreamResponse = Pick<ServerResponse, 'on' | 'off' | 'writeHead' | 'write' | 'end' | 'writableEnded'>;
type OpenClawStreamReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<unknown>;
  releaseLock: () => void;
};

async function writeOpenClawStreamChunk(
  res: OpenClawStreamResponse,
  chunk: Uint8Array,
): Promise<void> {
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err);
    };
    res.on('drain', onDrain);
    res.on('close', onClose);
    res.on('error', onError);
  });
}

export async function pipeOpenClawStream(
  req: OpenClawStreamRequest,
  res: OpenClawStreamResponse,
  reader: OpenClawStreamReader,
): Promise<void> {
  let clientGone = false;
  const cancelUpstream = () => {
    if (clientGone) return;
    clientGone = true;
    void reader.cancel().catch(() => {});
  };

  req.on('aborted', cancelUpstream);
  res.on('close', () => {
    if (!res.writableEnded) cancelUpstream();
  });
  res.on('error', cancelUpstream);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || clientGone) break;
      if (value !== undefined) {
        await writeOpenClawStreamChunk(res, value);
        if (clientGone) break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function isValidOpenClawPersistTurnPayload(payload: {
  sessionId?: unknown;
  userMessage?: unknown;
  assistantReply?: unknown;
}): payload is {
  sessionId: string;
  userMessage: string;
  assistantReply: string;
  turnId?: unknown;
  toolCalls?: unknown;
} {
  return typeof payload.sessionId === 'string'
    && payload.sessionId.trim().length > 0
    && typeof payload.userMessage === 'string'
    && typeof payload.assistantReply === 'string';
}

let _standaloneCache: boolean | null = null;
function resolveAutoUpdateEnabled(config: DkgConfig): boolean {
  if (_standaloneCache === null) _standaloneCache = isStandaloneInstall();
  return _standaloneCache ? (config.autoUpdate?.enabled !== false) : (config.autoUpdate?.enabled ?? false);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  agent: DKGAgent,
  publisherControl: ReturnType<typeof createPublisherControlFromStore>,
  config: DkgConfig,
  startedAt: number,
  dashDb: DashboardDB,
  opWallets: import('@origintrail-official/dkg-agent').OpWalletsConfig,
  network: Awaited<ReturnType<typeof loadNetworkConfig>>,
  tracker: OperationTracker,
  memoryManager: ChatMemoryManager,
  bridgeAuthToken: string | undefined,
  nodeVersion: string,
  nodeCommit: string,
  catchupTracker: CatchupTracker,
  extractionRegistry: ExtractionPipelineRegistry,
  fileStore: FileStore,
  extractionStatus: Map<string, ExtractionStatusRecord>,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;

  // GET /.well-known/skill.md — Agent Skills document (PUBLIC, no auth)
  if (req.method === 'GET' && path === '/.well-known/skill.md') {
    const proto = req.headers['x-forwarded-proto'] ?? 'http';
    const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${config.listenPort ?? 9200}`;
    const baseUrl = `${proto}://${host}`;
    // text/markdown is always handled natively by the import-file route
    // (skip Phase 1, run the Phase 2 markdown extractor directly), even when
    // no Phase 1 converter is registered. Surface it in the discovery list so
    // skill-driven clients see Markdown ingestion as supported regardless of
    // converter availability.
    const pipelines = extractionRegistry.availableContentTypes();
    const content = buildSkillMd({
      version: nodeVersion,
      baseUrl,
      peerId: agent.peerId,
      nodeRole: config.nodeRole ?? 'edge',
      extractionPipelines: [...new Set(['text/markdown', ...pipelines])],
    });
    const etag = skillEtag(content);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'ETag': etag,
      'Cache-Control': 'public, max-age=300',
      'Vary': 'Host, X-Forwarded-Host, X-Forwarded-Proto',
    });
    res.end(content);
    return;
  }

  // GET /api/status
  if (req.method === 'GET' && path === '/api/status') {
    const allConns = agent.node.libp2p.getConnections();
    const directConns = allConns.filter(c => !c.remoteAddr?.toString().includes('/p2p-circuit'));
    const relayedConns = allConns.length - directConns.length;
    const uniquePeers = new Set(allConns.map(c => c.remotePeer.toString()));
    const circuitAddrs = agent.multiaddrs.filter(a => a.includes('/p2p-circuit/'));
    const networkId = await computeNetworkId();
    const chainConf = config.chain ?? network?.chain;
    const blockExplorerUrl = config.blockExplorerUrl ?? deriveBlockExplorerUrl(chainConf?.chainId);
    const identityId = agent.publisher.getIdentityId();
    return jsonResponse(res, 200, {
      name: config.name,
      version: nodeVersion,
      commit: nodeCommit || null,
      peerId: agent.peerId,
      nodeRole: config.nodeRole ?? 'edge',
      networkId: networkId.slice(0, 16),
      networkName: network?.networkName ?? null,
      storeBackend: config.store?.backend ?? 'oxigraph-worker',
      uptimeMs: Date.now() - startedAt,
      connectedPeers: uniquePeers.size,
      connections: { total: allConns.length, direct: directConns.length, relayed: relayedConns },
      relayConnected: circuitAddrs.length > 0,
      multiaddrs: agent.multiaddrs,
      blockExplorerUrl,
      identityId: String(identityId),
      hasIdentity: identityId > 0n,
      hasOpenClawChannel: config.openclawAdapter === true || !!(config.openclawChannel?.bridgeUrl || config.openclawChannel?.gatewayUrl),
      autoUpdate: resolveAutoUpdateEnabled(config),
      updateAvailable: lastUpdateCheck.checkedAt > 0 ? !lastUpdateCheck.upToDate : null,
      latestCommit: lastUpdateCheck.latestCommit || null,
      latestVersion: lastUpdateCheck.latestVersion || null,
    });
  }

  // GET /api/info — lightweight DevOps health check (authenticated)
  if (req.method === 'GET' && path === '/api/info') {
    const allConns = agent.node.libp2p.getConnections();
    const uniquePeers = new Set(allConns.map(c => c.remotePeer.toString()));
    const chainConf = config.chain ?? network?.chain;
    const now = Date.now();

    return jsonResponse(res, 200, {
      status: 'running',
      version: getNodeVersion(),
      name: config.name,
      peerId: agent.peerId,
      nodeRole: config.nodeRole ?? 'edge',
      network: network?.networkName ?? null,
      startedAt: new Date(startedAt).toISOString(),
      uptimeSeconds: Math.floor((now - startedAt) / 1000),
      timestamp: new Date(now).toISOString(),
      chain: chainConf ? {
        chainId: chainConf.chainId ?? null,
        rpcUrl: chainConf.rpcUrl,
        hubAddress: chainConf.hubAddress,
      } : null,
      peers: uniquePeers.size,
      paranets: resolveContextGraphs(config).length,
      telemetry: config.telemetry?.enabled ?? false,
      autoUpdate: resolveAutoUpdateEnabled(config),
      auth: config.auth?.enabled !== false,
    });
  }

  // GET /api/connections — detailed per-connection info with transport type
  if (req.method === 'GET' && path === '/api/connections') {
    const allConns = agent.node.libp2p.getConnections();
    const connections = allConns.map(c => {
      const addr = c.remoteAddr?.toString() ?? 'unknown';
      return {
        peerId: c.remotePeer.toString(),
        remoteAddr: addr,
        transport: addr.includes('/p2p-circuit') ? 'relayed' : 'direct',
        direction: c.direction,
        openedAt: c.timeline?.open ?? null,
        durationMs: c.timeline?.open ? Date.now() - c.timeline.open : null,
      };
    });
    const direct = connections.filter(c => c.transport === 'direct').length;
    return jsonResponse(res, 200, {
      total: connections.length,
      direct,
      relayed: connections.length - direct,
      connections,
    });
  }

  // GET /api/agents — enriched with live connection health
  // Optional query params: ?framework=X &skill_type=X
  if (req.method === 'GET' && path === '/api/agents') {
    const frameworkFilter = url.searchParams.get('framework') || undefined;
    const skillTypeFilter = url.searchParams.get('skill_type') || undefined;
    const agents = await agent.findAgents({
      ...(frameworkFilter ? { framework: frameworkFilter } : {}),
    });
    // If skill_type filter is requested, find agents offering that skill and intersect
    let filteredAgents = agents;
    if (skillTypeFilter) {
      const offerings = await agent.findSkills({ skillType: skillTypeFilter });
      const agentUris = new Set(offerings.map((o: any) => o.agentUri));
      filteredAgents = agents.filter((a: any) => agentUris.has(a.agentUri));
    }
    const allConns = agent.node.libp2p.getConnections();
    const connByPeer = new Map<string, { transport: string; direction: string; sinceMs: number }>();
    for (const c of allConns) {
      const pid = c.remotePeer.toString();
      if (!connByPeer.has(pid)) {
        connByPeer.set(pid, {
          transport: c.remoteAddr?.toString().includes('/p2p-circuit') ? 'relayed' : 'direct',
          direction: c.direction,
          sinceMs: c.timeline?.open ? Date.now() - c.timeline.open : 0,
        });
      }
    }
    const myPeerId = agent.peerId;
    const healthMap = agent.getPeerHealth();
    const enriched = filteredAgents.map((a: any) => {
      const isSelf = a.peerId === myPeerId;
      const conn = connByPeer.get(a.peerId);
      const health = healthMap.get(a.peerId);
      return {
        ...a,
        connectionStatus: isSelf ? 'self' : conn ? 'connected' : 'disconnected',
        connectionTransport: conn?.transport ?? null,
        connectionDirection: conn?.direction ?? null,
        connectedSinceMs: conn?.sinceMs ?? null,
        lastSeen: isSelf ? Date.now() : (health?.lastSeen ?? null),
        latencyMs: health?.latencyMs ?? null,
      };
    });
    return jsonResponse(res, 200, { agents: enriched });
  }

  // GET /api/skills
  // Optional query params: ?skillType=X
  if (req.method === 'GET' && path === '/api/skills') {
    const skillTypeFilter = url.searchParams.get('skillType') || undefined;
    const skills = await agent.findSkills(
      skillTypeFilter ? { skillType: skillTypeFilter } : undefined,
    );
    return jsonResponse(res, 200, { skills });
  }

  // POST /api/invoke-skill  { peerId: "...", skillUri: "...", input: "..." }
  if (req.method === 'POST' && path === '/api/invoke-skill') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid JSON body' });
    }
    const rawPeerId = parsed.peerId ? String(parsed.peerId) : '';
    const skillUri = parsed.skillUri ? String(parsed.skillUri) : '';
    const input = parsed.input != null ? String(parsed.input) : '';
    if (!rawPeerId || !skillUri) return jsonResponse(res, 400, { error: 'Missing "peerId" or "skillUri"' });

    // Resolve name → peerId
    const peerId = await resolveNameToPeerId(agent, rawPeerId);
    if (!peerId) return jsonResponse(res, 404, { error: `Agent "${rawPeerId}" not found` });

    try {
      const inputData = new TextEncoder().encode(input);
      const response = await agent.invokeSkill(peerId, skillUri, inputData);
      return jsonResponse(res, 200, {
        success: response.success,
        output: response.outputData ? new TextDecoder().decode(response.outputData) : undefined,
        error: response.error,
        executionTimeMs: response.executionTimeMs,
      });
    } catch (err: any) {
      return jsonResponse(res, 502, { error: err.message });
    }
  }

  // POST /api/chat  { to: "name-or-peerId", text: "..." }
  if (req.method === 'POST' && path === '/api/chat') {
    const serverT0 = Date.now();
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { to, text } = JSON.parse(body);
    if (!to || !text) return jsonResponse(res, 400, { error: 'Missing "to" or "text"' });

    const resolveT0 = Date.now();
    const peerId = await resolveNameToPeerId(agent, to);
    const resolveDur = Date.now() - resolveT0;
    if (!peerId) return jsonResponse(res, 404, { error: `Agent "${to}" not found` });

    const sendT0 = Date.now();
    const result = await Promise.race([
      agent.sendChat(peerId, text),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sendChat timeout (30s)')), 30_000)),
    ]);
    const sendDur = Date.now() - sendT0;
    try { dashDb.insertChatMessage({ ts: Date.now(), direction: 'out', peer: peerId, text, delivered: result.delivered }); } catch { /* never crash */ }
    return jsonResponse(res, 200, { ...result, phases: { resolve: resolveDur, send: sendDur, serverTotal: Date.now() - serverT0 } });
  }

  // GET /api/messages?peer=<name-or-id>&limit=N
  if (req.method === 'GET' && path === '/api/messages') {
    const peerFilter = url.searchParams.get('peer');
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
    const since = parseInt(url.searchParams.get('since') ?? '0', 10);

    let peer: string | undefined;
    if (peerFilter) {
      peer = (await resolveNameToPeerId(agent, peerFilter)) ?? undefined;
    }
    const rows = dashDb.getChatMessages({ peer, since: since || undefined, limit });
    const msgs = rows.map(r => ({
      ts: r.ts,
      direction: r.direction,
      peer: r.peer,
      peerName: r.peer_name ?? undefined,
      text: r.text,
      delivered: r.delivered == null ? undefined : r.delivered === 1,
    }));
    return jsonResponse(res, 200, { messages: msgs });
  }

  // GET /api/openclaw-agents — discover connected OpenClaw agents
  if (req.method === 'GET' && path === '/api/openclaw-agents') {
    try {
      const allAgents = await agent.findAgents({ framework: 'OpenClaw' });
      const allConns = agent.node.libp2p.getConnections();
      const connectedPeers = new Set(allConns.map((c: any) => c.remotePeer.toString()));
      const healthMap = agent.getPeerHealth();

      const enriched = allAgents.map((a: any) => {
        const isConnected = connectedPeers.has(a.peerId);
        const health = healthMap.get(a.peerId);
        return {
          peerId: a.peerId,
          name: a.name,
          description: a.description,
          framework: a.framework,
          connected: isConnected,
          lastSeen: health?.lastSeen ?? null,
          latencyMs: health?.latencyMs ?? null,
        };
      });
      return jsonResponse(res, 200, { agents: enriched });
    } catch (err: any) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // POST /api/chat-openclaw  { peerId: "...", text: "..." }
  // Sends a message to an OpenClaw agent via P2P and waits for a response.
  if (req.method === 'POST' && path === '/api/chat-openclaw') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { peerId: rawPeerId, text } = JSON.parse(body);
    if (!rawPeerId || !text) return jsonResponse(res, 400, { error: 'Missing "peerId" or "text"' });

    const peerId = await resolveNameToPeerId(agent, rawPeerId);
    if (!peerId) return jsonResponse(res, 404, { error: `Agent "${rawPeerId}" not found` });

    const waitStart = Date.now();
    const sendResult = await agent.sendChat(peerId, text);
    try { dashDb.insertChatMessage({ ts: Date.now(), direction: 'out', peer: peerId, text, delivered: sendResult.delivered }); } catch { /* never crash */ }

    if (!sendResult.delivered) {
      return jsonResponse(res, 200, {
        delivered: false,
        reply: null,
        timedOut: false,
        error: sendResult.error ?? 'Message not delivered — agent may be offline',
      });
    }

    // Wait for a reply from the OpenClaw agent (poll incoming messages)
    const TIMEOUT_MS = 30_000;
    const POLL_MS = 500;
    let reply: string | null = null;

    while (Date.now() - waitStart < TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, POLL_MS));
      try {
        const rows = dashDb.getChatMessages({ peer: peerId, since: waitStart - 100, limit: 10 });
        const incoming = rows.filter(
          (r: any) => r.direction === 'in' && r.ts >= waitStart && r.peer === peerId,
        );
        if (incoming.length > 0) {
          reply = incoming[incoming.length - 1].text;
          break;
        }
      } catch { /* ignore */ }
    }

    return jsonResponse(res, 200, {
      delivered: true,
      reply: reply ?? null,
      timedOut: reply === null,
      waitMs: Date.now() - waitStart,
    });
  }

  // -----------------------------------------------------------------------
  // OpenClaw channel bridge — routes DKG UI messages through OpenClaw agent
  // -----------------------------------------------------------------------

  // POST /api/openclaw-channel/send  { text, correlationId, identity? }
  // DKG Node UI frontend calls this to send a message to the local OpenClaw
  // agent.  The daemon forwards to the adapter's channel bridge server and
  // returns the agent's reply.
  if (req.method === 'POST' && path === '/api/openclaw-channel/send') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let payload: { text?: string; correlationId?: string; identity?: string };
    try { payload = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON' }); }

    const { text, correlationId, identity } = payload;
    if (!text) return jsonResponse(res, 400, { error: 'Missing "text"' });
    const corrId = correlationId ?? crypto.randomUUID();

    const targets = getOpenClawChannelTargets(config);
    let lastFailure: { status?: number; details?: string; offline?: boolean } | null = null;

    for (const target of targets) {
      const availability = await ensureOpenClawBridgeAvailable(target, bridgeAuthToken);
      if (!availability.ok) {
        lastFailure = availability;
        continue;
      }

      try {
        const forwardRes = await fetch(target.inboundUrl, {
          method: 'POST',
          headers: buildOpenClawChannelHeaders(
            target,
            bridgeAuthToken,
            { 'Content-Type': 'application/json' },
          ),
          body: JSON.stringify({ text, correlationId: corrId, identity: identity ?? 'owner' }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!forwardRes.ok) {
          const details = await forwardRes.text().catch(() => '');
          if (shouldTryNextOpenClawTarget(forwardRes.status)) {
            lastFailure = {
              status: forwardRes.status,
              details: details || `${target.name} transport unavailable`,
              offline: forwardRes.status === 503,
            };
            continue;
          }
          return jsonResponse(res, 502, { error: 'Bridge error', code: 'BRIDGE_ERROR', details });
        }
        if (target.name === 'bridge') {
          bridgeHealthCache = { ok: true, ts: Date.now() };
        }
        const reply = await forwardRes.json();
        return jsonResponse(res, 200, reply);
      } catch (err: any) {
        if (err.name === 'TimeoutError') {
          return jsonResponse(res, 504, { error: 'Agent response timeout', code: 'AGENT_TIMEOUT', correlationId: corrId });
        }
        if (target.name === 'bridge') {
          bridgeHealthCache = { ok: false, ts: Date.now() };
        }
        lastFailure = { details: err.message, offline: true };
      }
    }

    return jsonResponse(
      res,
      lastFailure?.offline ? 503 : 502,
      {
        error: lastFailure?.offline ? 'OpenClaw bridge unreachable' : 'Bridge error',
        code: lastFailure?.offline ? 'BRIDGE_OFFLINE' : 'BRIDGE_ERROR',
        details: lastFailure?.details,
      },
    );
  }

  // POST /api/openclaw-channel/stream  { text, correlationId, identity? }
  // SSE streaming variant — pipes agent response chunks as they arrive.
  if (req.method === 'POST' && path === '/api/openclaw-channel/stream') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let payload: { text?: string; correlationId?: string; identity?: string };
    try { payload = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON' }); }

    const { text, correlationId, identity } = payload;
    if (!text) return jsonResponse(res, 400, { error: 'Missing "text"' });
    const corrId = correlationId ?? crypto.randomUUID();

    const targets = getOpenClawChannelTargets(config);
    let lastFailure: { status?: number; details?: string; offline?: boolean } | null = null;

    for (const target of targets) {
      const availability = await ensureOpenClawBridgeAvailable(target, bridgeAuthToken);
      if (!availability.ok) {
        lastFailure = availability;
        continue;
      }

      try {
        const transportRes = await fetch(target.streamUrl ?? target.inboundUrl, {
          method: 'POST',
          headers: buildOpenClawChannelHeaders(
            target,
            bridgeAuthToken,
            {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
            },
          ),
          body: JSON.stringify({ text, correlationId: corrId, identity: identity ?? 'owner' }),
          signal: AbortSignal.timeout(120_000),
        });

        if (!transportRes.ok) {
          const details = await transportRes.text().catch(() => '');
          if (shouldTryNextOpenClawTarget(transportRes.status)) {
            lastFailure = {
              status: transportRes.status,
              details: details || `${target.name} transport unavailable`,
              offline: transportRes.status === 503,
            };
            continue;
          }
          return jsonResponse(res, 502, { error: 'Bridge error', code: 'BRIDGE_ERROR', details });
        }

        if (target.name === 'bridge') {
          bridgeHealthCache = { ok: true, ts: Date.now() };
        }

        const contentType = (transportRes.headers.get('content-type') ?? '').toLowerCase();
        if (contentType.includes('text/event-stream') && transportRes.body) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...corsHeaders(resolveCorsOrigin(req, _moduleCorsAllowed)),
          });

          try {
            await pipeOpenClawStream(req, res, (transportRes.body as any).getReader());
          } catch (err: any) {
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            }
          }
          if (!res.writableEnded) res.end();
          return;
        }

        const reply = await transportRes.json();
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...corsHeaders(resolveCorsOrigin(req, _moduleCorsAllowed)),
        });
        res.write(`data: ${JSON.stringify({ type: 'final', text: reply.text ?? '', correlationId: reply.correlationId ?? corrId })}\n\n`);
        res.end();
        return;
      } catch (err: any) {
        if (err.name === 'TimeoutError') {
          return jsonResponse(res, 504, { error: 'Agent response timeout', code: 'AGENT_TIMEOUT', correlationId: corrId });
        }
        if (target.name === 'bridge') {
          bridgeHealthCache = { ok: false, ts: Date.now() };
        }
        lastFailure = { details: err.message, offline: true };
      }
    }

    return jsonResponse(
      res,
      lastFailure?.offline ? 503 : 502,
      {
        error: lastFailure?.offline ? 'OpenClaw bridge unreachable' : 'Bridge error',
        code: lastFailure?.offline ? 'BRIDGE_OFFLINE' : 'BRIDGE_ERROR',
        details: lastFailure?.details,
      },
    );
  }

  // POST /api/openclaw-channel/persist-turn  { sessionId, userMessage, assistantReply, ... }
  // Called by the adapter to persist an OpenClaw turn into the DKG agent-memory graph
  // using the same ChatMemoryManager pathway as built-in Agent Hub chat.
  if (req.method === 'POST' && path === '/api/openclaw-channel/persist-turn') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let payload: any;
    try { payload = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON' }); }

    if (!isValidOpenClawPersistTurnPayload(payload)) {
      return jsonResponse(res, 400, { error: 'Missing required fields: sessionId, userMessage, assistantReply' });
    }
    const { sessionId, userMessage, assistantReply, turnId, toolCalls } = payload;
    const normalizedToolCalls = Array.isArray(toolCalls)
      ? toolCalls as Array<{ name: string; args: Record<string, unknown>; result: unknown }>
      : undefined;
    const normalizedTurnId = typeof turnId === 'string' ? turnId : crypto.randomUUID();
    try {
      await memoryManager.storeChatExchange(
        sessionId,
        userMessage,
        assistantReply,
        normalizedToolCalls,
        { turnId: normalizedTurnId, persistenceState: 'stored' },
      );
      return jsonResponse(res, 200, { ok: true });
    } catch (err: any) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // GET /api/openclaw-channel/health — check if the channel bridge is reachable
  if (req.method === 'GET' && path === '/api/openclaw-channel/health') {
    const targets = getOpenClawChannelTargets(config);
    let bridge: Record<string, unknown> | undefined;
    let gateway: Record<string, unknown> | undefined;
    let lastError = 'No OpenClaw channel health endpoint configured';

    for (const target of targets) {
      if (!target.healthUrl) continue;

      if (target.name === 'bridge') {
        if (!bridgeAuthToken) {
          bridge = { ok: false, error: 'Bridge auth token unavailable' };
          lastError = 'Bridge auth token unavailable';
          continue;
        }

        const cachedBridgeHealth = bridgeHealthCache;
        const cacheValid = cachedBridgeHealth !== null && (Date.now() - cachedBridgeHealth.ts < HEALTH_CACHE_TTL);
        if (cacheValid) {
          bridge = { ok: cachedBridgeHealth.ok, cached: true };
          if (cachedBridgeHealth.ok) {
            return jsonResponse(res, 200, { ok: true, target: 'bridge', bridge });
          }
          continue;
        }
      }

      try {
        const healthRes = await fetch(target.healthUrl, {
          headers: buildOpenClawChannelHeaders(target, bridgeAuthToken, { Accept: 'application/json' }),
          signal: AbortSignal.timeout(5_000),
        });
        const body = await healthRes.text().catch(() => '');
        let parsed: Record<string, unknown> = {};
        if (body) {
          try {
            parsed = JSON.parse(body) as Record<string, unknown>;
          } catch {
            parsed = { body };
          }
        }
        const result: Record<string, unknown> & { ok: boolean } = { ok: healthRes.ok, ...parsed };
        if (target.name === 'bridge') {
          bridgeHealthCache = { ok: healthRes.ok, ts: Date.now() };
          bridge = result;
        } else {
          gateway = result;
        }
        if (healthRes.ok) {
          return jsonResponse(res, 200, {
            ok: true,
            target: target.name,
            bridge,
            gateway,
          });
        }
        lastError = typeof result.error === 'string'
          ? result.error
          : `Health endpoint responded ${healthRes.status}`;
      } catch (err: any) {
        const result = { ok: false, error: err.message };
        if (target.name === 'bridge') {
          bridgeHealthCache = { ok: false, ts: Date.now() };
          bridge = result;
        } else {
          gateway = result;
        }
        lastError = err.message;
      }
    }

    return jsonResponse(res, 200, { ok: false, bridge, gateway, error: lastError });
  }

  // POST /api/connect  { multiaddr: "..." }
  if (req.method === 'POST' && path === '/api/connect') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { multiaddr: addr } = JSON.parse(body);
    if (!addr) return jsonResponse(res, 400, { error: 'Missing "multiaddr"' });
    try {
      await agent.connectTo(addr);
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err.message ?? 'Failed to connect' });
    }
    return jsonResponse(res, 200, { connected: true });
  }

  // POST /api/update  { kcId: "...", contextGraphId|paranetId: "...", quads: [...], privateQuads?: [...] }
  if (req.method === 'POST' && path === '/api/update') {
    const body = await readBody(req);
    const parsed = JSON.parse(body);
    const { kcId, quads, privateQuads } = parsed;
    const paranetId = parsed.contextGraphId ?? parsed.paranetId;
    if (!kcId || !paranetId || !quads?.length) {
      return jsonResponse(res, 400, { error: 'Missing "kcId", "contextGraphId" (or "paranetId"), or "quads"' });
    }
    let kcIdBigInt: bigint;
    try { kcIdBigInt = BigInt(kcId); } catch {
      return jsonResponse(res, 400, { error: `Invalid "kcId": ${String(kcId).slice(0, 50)}` });
    }
    const ctx = createOperationContext('update');
    tracker.start(ctx, { contextGraphId: paranetId, details: { kcId: String(kcId), tripleCount: quads.length, source: 'api' } });
    try {
      const result = await agent.update(kcIdBigInt, paranetId, quads, privateQuads, {
        operationCtx: ctx,
        onPhase: tracker.phaseCallback(ctx),
      });
      const chain = result.onChainResult;
      if (chain) {
        tracker.setCost(ctx, { gasUsed: chain.gasUsed, gasPrice: chain.effectiveGasPrice, gasCost: chain.gasCostWei, tracCost: chain.tokenAmount });
        const chainId = (config.chain ?? network?.chain)?.chainId;
        tracker.setTxHash(ctx, chain.txHash, chainId ? Number(chainId) : undefined);
      }
      if (result.status === 'failed') {
        tracker.fail(ctx, new Error(`Update failed on-chain (kcId=${kcId})`));
      } else {
        tracker.complete(ctx, { tripleCount: quads.length, details: { kcId: String(result.kcId), status: result.status } });
      }
      const opDetail = dashDb.getOperation(ctx.operationId);
      return jsonResponse(res, 200, {
        kcId: String(result.kcId),
        status: result.status,
        kas: result.kaManifest.map(ka => ({ tokenId: String(ka.tokenId), rootEntity: ka.rootEntity })),
        ...(chain && { txHash: chain.txHash, blockNumber: chain.blockNumber }),
        phases: opDetail.phases,
      });
    } catch (err) {
      tracker.fail(ctx, err);
      throw err;
    }
  }

  // POST /api/shared-memory/write (V10) or /api/workspace/write (legacy)
  if (req.method === 'POST' && (path === '/api/shared-memory/write' || path === '/api/workspace/write')) {
    const body = await readBody(req);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { quads, subGraphName } = parsed;
    const localOnly = parsed.localOnly === true;
    if (parsed.localOnly !== undefined && typeof parsed.localOnly !== 'boolean') {
      return jsonResponse(res, 400, { error: '"localOnly" must be a boolean' });
    }
    const paranetId = parsed.contextGraphId ?? parsed.paranetId;
    if (!paranetId || !quads?.length) {
      return jsonResponse(res, 400, { error: 'Missing "contextGraphId" (or "paranetId") or "quads"' });
    }
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    const ctx = createOperationContext('share');
    tracker.start(ctx, { contextGraphId: paranetId, details: { tripleCount: quads.length, source: 'api', subGraphName } });
    try {
      await tracker.trackPhase(ctx, 'validate', async () => {
        // validation happens inside share
      });
      const result = await tracker.trackPhase(ctx, 'store', () =>
        agent.share(paranetId, quads, { subGraphName, localOnly, operationCtx: ctx }),
      );
      tracker.complete(ctx, { tripleCount: quads.length });
      return jsonResponse(res, 200, {
        shareOperationId: result?.shareOperationId,
        workspaceOperationId: result?.shareOperationId,
        contextGraphId: paranetId,
        paranetId,
        graph: contextGraphSharedMemoryUri(paranetId, subGraphName),
        triplesWritten: quads.length,
      });
    } catch (err) {
      tracker.fail(ctx, err);
      throw err;
    }
  }

  // POST /api/shared-memory/publish (V10) or /api/workspace/enshrine (legacy)
  if (req.method === 'POST' && (path === '/api/shared-memory/publish' || path === '/api/workspace/enshrine')) {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { selection, clearAfter, publishContextGraphId, subGraphName } = parsed;
    const paranetId = parsed.contextGraphId ?? parsed.paranetId;
    if (!paranetId) return jsonResponse(res, 400, { error: 'Missing "contextGraphId" (or "paranetId")' });
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    if (subGraphName && publishContextGraphId) {
      return jsonResponse(res, 400, { error: '"subGraphName" and "publishContextGraphId" cannot be used together' });
    }
    const ctx = createOperationContext('publishFromSWM');
    tracker.start(ctx, { contextGraphId: paranetId, details: { source: 'api', publishContextGraphId, subGraphName } });
    try {
      const sel: 'all' | { rootEntities: string[] } =
        Array.isArray(selection) ? { rootEntities: selection } : (selection || 'all');
      const result = await tracker.trackPhase(ctx, 'read-shared-memory', () =>
        agent.publishFromSharedMemory(paranetId, sel, {
          clearSharedMemoryAfter: clearAfter ?? true,
          operationCtx: ctx,
          subGraphName,
          ...(publishContextGraphId != null ? { contextGraphId: String(publishContextGraphId) } : {}),
        }),
      );
      const chain = result.onChainResult;
      if (chain) {
        tracker.setCost(ctx, { gasUsed: chain.gasUsed, gasPrice: chain.effectiveGasPrice });
        const chainId = (config.chain ?? network?.chain)?.chainId;
        tracker.setTxHash(ctx, chain.txHash, chainId ? Number(chainId) : undefined);
      }
      tracker.complete(ctx, { tripleCount: result.kaManifest?.length ?? 0 });
      const httpStatus = result.contextGraphError ? 207 : 200;
      return jsonResponse(res, httpStatus, {
        kcId: String(result.kcId),
        status: result.status,
        kas: result.kaManifest.map(ka => ({ tokenId: String(ka.tokenId), rootEntity: ka.rootEntity })),
        ...(chain && { txHash: chain.txHash, blockNumber: chain.blockNumber }),
        ...(publishContextGraphId != null ? { publishContextGraphId: String(publishContextGraphId) } : {}),
        ...(result.contextGraphError ? { contextGraphError: result.contextGraphError } : {}),
      });
    } catch (err) {
      tracker.fail(ctx, err);
      throw err;
    }
  }

  // POST /api/publisher/enqueue
  // Accepts both the old wrapped shape { request: LiftRequest } and the new flat shape.
  if (req.method === 'POST' && path === '/api/publisher/enqueue') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let raw: any;
    try { raw = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }
    const parsed = raw.request && typeof raw.request === 'object' ? raw.request : raw;
    const { roots, namespace, scope, authorityProofRef, priorVersion } = parsed;
    const contextGraphId = parsed.contextGraphId ?? parsed.paranetId;
    const shareOperationId = parsed.shareOperationId ?? parsed.workspaceOperationId;
    const swmId = parsed.swmId ?? parsed.workspaceId ?? 'swm-main';
    const transitionType = parsed.transitionType ?? 'CREATE';
    const authorityType = parsed.authorityType ?? parsed.authority?.type ?? 'owner';
    const proofRef = authorityProofRef ?? parsed.authority?.proofRef;
    if (!contextGraphId || !shareOperationId || !Array.isArray(roots) || roots.length === 0 || !namespace || !scope || !proofRef) {
      return jsonResponse(res, 400, { error: 'Missing required enqueue fields' });
    }
    const jobId = await publisherControl.lift({
      swmId,
      shareOperationId,
      roots,
      contextGraphId,
      namespace,
      scope,
      transitionType,
      authority: { type: authorityType, proofRef },
      ...(priorVersion ? { priorVersion } : {}),
    } as any);
    return jsonResponse(res, 200, { jobId, contextGraphId, shareOperationId, rootsCount: roots.length });
  }

  // GET /api/publisher/jobs?status=...
  if (req.method === 'GET' && path === '/api/publisher/jobs') {
    const status = typeof url.searchParams.get('status') === 'string' ? url.searchParams.get('status')! : undefined;
    const jobs = await publisherControl.list(status ? { status: status as any } : undefined);
    return jsonResponse(res, 200, { jobs });
  }

  // GET /api/publisher/job?id=...  (new route, wrapped response)
  if (req.method === 'GET' && path === '/api/publisher/job') {
    const jobId = url.searchParams.get('id');
    if (!jobId) return jsonResponse(res, 400, { error: 'Missing job id' });
    const job = await publisherControl.getStatus(jobId);
    if (!job) return jsonResponse(res, 404, { error: `Publisher job not found: ${jobId}` });
    return jsonResponse(res, 200, { job });
  }

  // GET /api/publisher/job-payload?id=...  (new route, wrapped response)
  if (req.method === 'GET' && path === '/api/publisher/job-payload') {
    const jobId = url.searchParams.get('id');
    if (!jobId) return jsonResponse(res, 400, { error: 'Missing job id' });
    const job = await publisherControl.getStatus(jobId);
    if (!job) return jsonResponse(res, 404, { error: `Publisher job not found: ${jobId}` });
    const payload = await publisherControl.inspectPreparedPayload(jobId);
    return jsonResponse(res, 200, { job, payload });
  }

  // Legacy: GET /api/publisher/jobs/:id and /api/publisher/jobs/:id/payload (bare response)
  if (req.method === 'GET' && path.startsWith('/api/publisher/jobs/')) {
    const segments = path.slice('/api/publisher/jobs/'.length).split('/');
    const jobId = segments[0];
    if (!jobId) return jsonResponse(res, 400, { error: 'Missing job id' });
    const job = await publisherControl.getStatus(jobId);
    if (!job) return jsonResponse(res, 404, { error: `Publisher job not found: ${jobId}` });
    if (segments[1] === 'payload') {
      const payload = await publisherControl.inspectPreparedPayload(jobId);
      return jsonResponse(res, 200, { ...job, payload });
    }
    return jsonResponse(res, 200, job);
  }

  // GET /api/publisher/stats — returns the raw status map directly for backward compat
  if (req.method === 'GET' && path === '/api/publisher/stats') {
    const stats = await publisherControl.getStats();
    return jsonResponse(res, 200, stats);
  }

  // POST /api/publisher/cancel
  if (req.method === 'POST' && path === '/api/publisher/cancel') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }
    const { jobId } = parsed;
    if (!jobId) return jsonResponse(res, 400, { error: 'Missing jobId' });
    await publisherControl.cancel(jobId);
    return jsonResponse(res, 200, { cancelled: jobId });
  }

  // POST /api/publisher/retry
  if (req.method === 'POST' && path === '/api/publisher/retry') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let retryParsed: any;
    try { retryParsed = JSON.parse(body || '{}'); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }
    const { status } = retryParsed;
    if (status && status !== 'failed') return jsonResponse(res, 400, { error: 'Only status=failed is supported' });
    const count = await publisherControl.retry({ status: 'failed' });
    return jsonResponse(res, 200, { retried: count });
  }

  // POST /api/publisher/clear
  if (req.method === 'POST' && path === '/api/publisher/clear') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let clearParsed: any;
    try { clearParsed = JSON.parse(body || '{}'); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }
    const { status } = clearParsed;
    if (status !== 'failed' && status !== 'finalized') {
      return jsonResponse(res, 400, { error: 'status must be failed or finalized' });
    }
    const count = await publisherControl.clear(status);
    return jsonResponse(res, 200, { cleared: count, status });
  }

  // POST /api/context-graph/create — on-chain context graph creation (V10)
  // When the body has `participantIdentityIds`, this is the on-chain multisig creation.
  // Otherwise, fall through to the context-graph-style create handler below.
  if (req.method === 'POST' && path === '/api/context-graph/create') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed.participantIdentityIds)) {
      const { participantIdentityIds, requiredSignatures } = parsed;
      if (typeof requiredSignatures !== 'number') {
        return jsonResponse(res, 400, { error: 'Missing requiredSignatures (number)' });
      }
      if (!Number.isInteger(requiredSignatures) || requiredSignatures < 1) {
        return jsonResponse(res, 400, { error: 'requiredSignatures must be a positive integer (>= 1)' });
      }
      if (requiredSignatures > participantIdentityIds.length) {
        return jsonResponse(res, 400, { error: `requiredSignatures (${requiredSignatures}) cannot exceed participantIdentityIds count (${participantIdentityIds.length})` });
      }
      for (let i = 0; i < participantIdentityIds.length; i++) {
        const id = participantIdentityIds[i];
        if (typeof id === 'number') {
          if (!Number.isInteger(id) || id <= 0 || id > Number.MAX_SAFE_INTEGER) {
            return jsonResponse(res, 400, { error: `participantIdentityIds[${i}] must be a positive safe integer` });
          }
        } else if (typeof id === 'string') {
          if (!/^\d+$/.test(id) || id === '0') {
            return jsonResponse(res, 400, { error: `participantIdentityIds[${i}] must be a positive decimal integer string` });
          }
        } else {
          return jsonResponse(res, 400, { error: `participantIdentityIds[${i}] must be a number or string` });
        }
      }
      try {
        const mappedIds = participantIdentityIds.map((id: number | string) => BigInt(id));
        const uniqueIds: bigint[] = Array.from(new Set(mappedIds));
        const sortedUniqueIds = uniqueIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        if (requiredSignatures > sortedUniqueIds.length) {
          return jsonResponse(res, 400, {
            error: `requiredSignatures (${requiredSignatures}) exceeds unique participant count (${sortedUniqueIds.length}) after deduplication`,
          });
        }
        const result = await agent.registerContextGraphOnChain({
          participantIdentityIds: sortedUniqueIds,
          requiredSignatures,
        });
        return jsonResponse(res, 200, { contextGraphId: String(result.contextGraphId), success: true });
      } catch (err: any) {
        return jsonResponse(res, 500, { error: err.message });
      }
    }
    // Body has `id` + `name` → context-graph-style context graph definition create (handled below)
    const { id, name, description } = parsed;
    if (!id || !name) return jsonResponse(res, 400, { error: 'Missing "id" or "name"' });
    if (!isValidContextGraphId(id)) return jsonResponse(res, 400, { error: 'Invalid context graph id' });
    try {
      await agent.createContextGraph({ id, name, description });
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (msg.includes('already exists') || msg.includes('duplicate') || msg.includes('conflict')) {
        return jsonResponse(res, 409, { error: msg });
      }
      throw err;
    }
    return jsonResponse(res, 200, { created: id, uri: `did:dkg:context-graph:${id}` });
  }

  // POST /api/sub-graph/create  { contextGraphId, subGraphName }
  if (req.method === 'POST' && path === '/api/sub-graph/create') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, subGraphName } = parsed;
    if (!subGraphName) return jsonResponse(res, 400, { error: 'Missing "subGraphName"' });
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (typeof subGraphName !== 'string') return jsonResponse(res, 400, { error: '"subGraphName" must be a string' });
    const sgVal = validateSubGraphName(subGraphName);
    if (!sgVal.valid) return jsonResponse(res, 400, { error: `Invalid "subGraphName": ${sgVal.reason}` });
    try {
      await agent.createSubGraph(contextGraphId, subGraphName);
      return jsonResponse(res, 200, { created: subGraphName, contextGraphId });
    } catch (err: any) {
      if (err.message?.includes('already exists') || err.message?.includes('not found') || err.message?.includes('Invalid')) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/assertion/create  { contextGraphId, name, subGraphName? }
  if (req.method === 'POST' && path === '/api/assertion/create') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, name, subGraphName } = parsed;
    if (!name) return jsonResponse(res, 400, { error: 'Missing "name"' });
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (typeof name !== 'string') return jsonResponse(res, 400, { error: '"name" must be a string' });
    const nameVal = validateAssertionName(name);
    if (!nameVal.valid) return jsonResponse(res, 400, { error: `Invalid "name": ${nameVal.reason}` });
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      const assertionUri = await agent.assertion.create(contextGraphId, name, subGraphName ? { subGraphName } : undefined);
      return jsonResponse(res, 200, { assertionUri });
    } catch (err: any) {
      if (err.message?.includes('already exists') || err.message?.includes('not found') || err.message?.includes('Invalid')) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/assertion/:name/write  { contextGraphId, quads, subGraphName? }
  if (req.method === 'POST' && path.startsWith('/api/assertion/') && path.endsWith('/write')) {
    const assertionName = safeDecodeURIComponent(path.slice('/api/assertion/'.length, -'/write'.length), res);
    if (assertionName === null) return;
    const nameVal = validateAssertionName(assertionName);
    if (!nameVal.valid) return jsonResponse(res, 400, { error: `Invalid assertion name: ${nameVal.reason}` });
    const body = await readBody(req);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, quads, subGraphName } = parsed;
    if (!quads?.length) return jsonResponse(res, 400, { error: 'Missing "quads"' });
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      await agent.assertion.write(contextGraphId, assertionName, quads, subGraphName ? { subGraphName } : undefined);
      return jsonResponse(res, 200, { written: quads.length });
    } catch (err: any) {
      if (
        err.message?.includes('not found')
        || err.message?.includes('Invalid')
        || err.message?.includes('Unsafe')
        // Round 9 Bug 25: reserved-namespace writes surface as 400.
        || err.name === 'ReservedNamespaceError'
        || err.message?.includes('reserved namespace')
      ) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/assertion/:name/query  { contextGraphId, subGraphName? }
  if (req.method === 'POST' && path.startsWith('/api/assertion/') && path.endsWith('/query')) {
    const assertionName = safeDecodeURIComponent(path.slice('/api/assertion/'.length, -'/query'.length), res);
    if (assertionName === null) return;
    const nameVal = validateAssertionName(assertionName);
    if (!nameVal.valid) return jsonResponse(res, 400, { error: `Invalid assertion name: ${nameVal.reason}` });
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, subGraphName } = parsed;
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      const quads = await agent.assertion.query(contextGraphId, assertionName, subGraphName ? { subGraphName } : undefined);
      return jsonResponse(res, 200, { quads, count: quads.length });
    } catch (err: any) {
      if (err.message?.includes('not found') || err.message?.includes('Invalid') || err.message?.includes('Unsafe')) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/assertion/:name/promote  { contextGraphId, entities?, subGraphName? }
  if (req.method === 'POST' && path.startsWith('/api/assertion/') && path.endsWith('/promote')) {
    const assertionName = safeDecodeURIComponent(path.slice('/api/assertion/'.length, -'/promote'.length), res);
    if (assertionName === null) return;
    const nameVal = validateAssertionName(assertionName);
    if (!nameVal.valid) return jsonResponse(res, 400, { error: `Invalid assertion name: ${nameVal.reason}` });
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, entities, subGraphName } = parsed;
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (!validateEntities(entities, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      const result = await agent.assertion.promote(contextGraphId, assertionName, { entities: entities ?? 'all', subGraphName });
      return jsonResponse(res, 200, result);
    } catch (err: any) {
      if (err.message?.includes('not found') || err.message?.includes('Invalid') || err.message?.includes('Unsafe')) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/assertion/:name/discard  { contextGraphId, subGraphName? }
  if (req.method === 'POST' && path.startsWith('/api/assertion/') && path.endsWith('/discard')) {
    const assertionName = safeDecodeURIComponent(path.slice('/api/assertion/'.length, -'/discard'.length), res);
    if (assertionName === null) return;
    const nameVal = validateAssertionName(assertionName);
    if (!nameVal.valid) return jsonResponse(res, 400, { error: `Invalid assertion name: ${nameVal.reason}` });
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, subGraphName } = parsed;
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      await agent.assertion.discard(contextGraphId, assertionName, subGraphName ? { subGraphName } : undefined);
      return jsonResponse(res, 200, { discarded: true });
    } catch (err: any) {
      if (err.message?.includes('not found') || err.message?.includes('Invalid') || err.message?.includes('Unsafe')) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/assertion/:name/import-file  (multipart/form-data)
  //   file (required):           the uploaded document bytes
  //   contextGraphId (required): target context graph
  //   contentType (optional):    override the file part's Content-Type
  //   ontologyRef (optional):    CG _ontology URI for guided Phase 2 extraction
  //   subGraphName (optional):   target sub-graph inside the CG
  //
  // Orchestration:
  //   1. Parse multipart, store original file in file store → fileHash
  //   2. Resolve detectedContentType (explicit field > multipart content-type)
  //   3. If content type is text/markdown: skip Phase 1, use raw bytes as mdIntermediate
  //      Else if a converter is registered: run Phase 1, store mdIntermediate → mdIntermediateHash
  //      Else: graceful degrade — return extraction.status="skipped", no triples written
  //   4. Run Phase 2 markdown extractor on the mdIntermediate → triples + provenance
  //   5. Write triples + provenance to the assertion graph via agent.assertion.write
  //   6. Record the extraction status in the in-memory Map, return ImportFileResponse
  if (req.method === 'POST' && path.startsWith('/api/assertion/') && path.endsWith('/import-file')) {
    const assertionName = safeDecodeURIComponent(path.slice('/api/assertion/'.length, -'/import-file'.length), res);
    if (assertionName === null) return;
    const nameVal = validateAssertionName(assertionName);
    if (!nameVal.valid) return jsonResponse(res, 400, { error: `Invalid assertion name: ${nameVal.reason}` });

    const boundary = parseBoundary(req.headers['content-type']);
    if (!boundary) {
      return jsonResponse(res, 400, { error: 'Request must be multipart/form-data with a boundary' });
    }

    let body: Buffer;
    try {
      body = await readBodyBuffer(req, MAX_UPLOAD_BYTES);
    } catch (err: any) {
      if (err instanceof PayloadTooLargeError) throw err;
      return jsonResponse(res, 400, { error: `Failed to read request body: ${err.message}` });
    }

    let fields;
    try {
      fields = parseMultipart(body, boundary);
    } catch (err: any) {
      if (err instanceof MultipartParseError) {
        return jsonResponse(res, 400, { error: `Malformed multipart body: ${err.message}` });
      }
      throw err;
    }

    const filePart = fields.find(f => f.name === 'file' && f.filename !== undefined);
    if (!filePart) {
      return jsonResponse(res, 400, { error: 'Missing required "file" field in multipart body' });
    }
    const textField = (name: string): string | undefined => {
      const f = fields.find(x => x.name === name && x.filename === undefined);
      return f ? f.content.toString('utf-8') : undefined;
    };
    const contextGraphId = textField('contextGraphId');
    const contentTypeOverrideRaw = textField('contentType');
    // Treat blank (`contentType=` with empty/whitespace value) as absent so we
    // fall through to the file part's own Content-Type header instead of
    // downgrading a real text/markdown / application/pdf upload to
    // application/octet-stream and silently skipping extraction.
    const contentTypeOverride =
      contentTypeOverrideRaw && contentTypeOverrideRaw.trim().length > 0
        ? contentTypeOverrideRaw
        : undefined;
    const ontologyRef = textField('ontologyRef');
    const subGraphName = textField('subGraphName');

    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;

    const detectedContentType = normalizeDetectedContentType(contentTypeOverride ?? filePart.contentType);

    if (subGraphName) {
      try {
        const registeredSubGraphs: Array<{ name: string }> = await agent.listSubGraphs(contextGraphId!);
        if (!registeredSubGraphs.some(subGraph => subGraph.name === subGraphName)) {
          return jsonResponse(res, 400, { error: unregisteredSubGraphError(contextGraphId!, subGraphName) });
        }
      } catch (err: any) {
        return jsonResponse(res, 500, { error: `Failed to verify sub-graph registration: ${err.message}` });
      }
    }

    // Persist the original upload to the file store.
    let fileStoreEntry;
    try {
      fileStoreEntry = await fileStore.put(filePart.content, detectedContentType);
    } catch (err: any) {
      return jsonResponse(res, 500, { error: `Failed to store uploaded file: ${err.message}` });
    }

    const assertionUri = contextGraphAssertionUri(
      contextGraphId!,
      agent.peerId,
      assertionName,
      subGraphName,
    );
    const startedAt = new Date().toISOString();

    // ── Round 14 Bug 42: per-assertion mutex BEFORE extraction ──
    //
    // Round 6 originally acquired this lock just before the
    // snapshot→insert→rollback critical section, AFTER Phase 1 and
    // Phase 2 extraction had already run. Concurrent imports of the
    // same assertion name then raced during extraction, and the one
    // whose extraction finished LAST committed LAST — regardless of
    // which request arrived first. Final stored state depended on
    // extraction duration (bytes-to-parse, converter latency, PDF
    // complexity), not request order.
    //
    // Option 42A fix: move the lock acquisition here, before any
    // extraction work begins. This serializes the entire import-file
    // handler per assertion name so concurrent imports commit in
    // request order, not in extraction-finish order.
    //
    // Tradeoff: a long-running extraction (large PDF through the
    // MarkItDown converter) now holds the lock and blocks other
    // imports of the SAME assertion name for the duration. In
    // practice, same-name re-imports should be rare (name collision
    // is usually a user mistake, not a workflow), so this is an
    // acceptable tradeoff for correctness. Imports of DIFFERENT
    // assertion names are unaffected — the lock is per-URI, not
    // global. Async extraction (if/when it lands) will need a
    // different locking story, but for V10.0's synchronous
    // extraction this is correct by construction.
    //
    // `releaseLock` is invoked in the outer `finally` block at the
    // bottom of the handler so the next waiter unblocks regardless
    // of success, failure, return, or throw.
    const previousLock = assertionImportLocks.get(assertionUri) ?? Promise.resolve();
    let releaseLock: () => void = () => {};
    const currentLock = new Promise<void>(resolve => { releaseLock = resolve; });
    const chainedLock = previousLock.then(() => currentLock);
    assertionImportLocks.set(assertionUri, chainedLock);
    await previousLock;

    try {
    // ── Phase 1: converter lookup + MD intermediate resolution ──
    // text/markdown is deliberately NOT a registered converter content type.
    // The raw uploaded bytes ARE the Markdown intermediate, so Phase 1 is skipped.
    // For any other content type, look up a converter; if none is registered,
    // gracefully degrade (store the file, skip extraction, return status=skipped).
    let mdIntermediate: string | null = null;
    let pipelineUsed: string | null = null;
    let mdIntermediateHash: string | undefined;
    const respondWithImportFileResponse = (statusCode: number, extraction: ImportFileExtractionPayload) =>
      jsonResponse(
        res,
        statusCode,
        buildImportFileResponse({
          assertionUri,
          fileHash: fileStoreEntry.keccak256,
          detectedContentType,
          extraction,
        }),
      );
    const recordInProgressExtraction = (): void => {
      setExtractionStatusRecord(extractionStatus, assertionUri, {
        status: 'in_progress',
        fileHash: fileStoreEntry.keccak256,
        detectedContentType,
        pipelineUsed,
        tripleCount: 0,
        ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
        startedAt,
      });
    };
    const recordFailedExtraction = (
      error: string,
      tripleCount: number,
      failedPipelineUsed: string | null = pipelineUsed,
    ): ExtractionStatusRecord => {
      const failedRecord: ExtractionStatusRecord = {
        status: 'failed',
        fileHash: fileStoreEntry.keccak256,
        detectedContentType,
        pipelineUsed: failedPipelineUsed,
        tripleCount,
        ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
        error,
        startedAt,
        completedAt: new Date().toISOString(),
      };
      setExtractionStatusRecord(extractionStatus, assertionUri, failedRecord);
      return failedRecord;
    };
    const respondWithFailedExtraction = (
      statusCode: number,
      error: string,
      tripleCount: number,
      failedPipelineUsed: string | null = pipelineUsed,
    ) => {
      const failedRecord = recordFailedExtraction(error, tripleCount, failedPipelineUsed);
      return respondWithImportFileResponse(statusCode, {
        status: 'failed',
        tripleCount,
        pipelineUsed: failedRecord.pipelineUsed,
        ...(failedRecord.mdIntermediateHash ? { mdIntermediateHash: failedRecord.mdIntermediateHash } : {}),
        error,
      });
    };

    recordInProgressExtraction();

    if (detectedContentType === 'text/markdown') {
      mdIntermediate = filePart.content.toString('utf-8');
      pipelineUsed = 'text/markdown';
      recordInProgressExtraction();
    } else {
      const converter = extractionRegistry.get(detectedContentType);
      if (converter) {
        try {
          const { mdIntermediate: md } = await converter.extract({
            filePath: fileStoreEntry.path,
            contentType: detectedContentType,
            ontologyRef,
            agentDid: `did:dkg:agent:${agent.peerId}`,
          });
          mdIntermediate = md;
          pipelineUsed = detectedContentType;
          const mdEntry = await fileStore.put(Buffer.from(md, 'utf-8'), 'text/markdown');
          mdIntermediateHash = mdEntry.keccak256;
          recordInProgressExtraction();
        } catch (err: any) {
          return respondWithFailedExtraction(500, `Phase 1 converter failed: ${err.message}`, 0, detectedContentType);
        }
      }
    }

    // ── Graceful degrade: no converter registered and not text/markdown ──
    // Store the file blob, return status=skipped, no triples written.
    if (mdIntermediate === null) {
      const skippedRecord: ExtractionStatusRecord = {
        status: 'skipped',
        fileHash: fileStoreEntry.keccak256,
        detectedContentType,
        pipelineUsed: null,
        tripleCount: 0,
        startedAt,
        completedAt: new Date().toISOString(),
      };
      setExtractionStatusRecord(extractionStatus, assertionUri, skippedRecord);
      return respondWithImportFileResponse(200, {
        status: 'skipped',
        tripleCount: 0,
        pipelineUsed: null,
      });
    }

    // ── Source-file linkage inputs for §10.1 / §10.2 triples ──
    // fileUri is the content-addressed URN the extractor stamps on the
    // document subject (row 1) and the daemon uses as both the subject of
    // the file descriptor block (rows 4-8) and the object of the extraction
    // provenance resource (row 10). provUri is a fresh UUID per import for
    // the ExtractionProvenance subject (rows 9-13).
    //
    // Cross-assertion promote contention on `<urn:dkg:file:...>` as a
    // root entity is prevented by a subject-prefix filter in
    // `packages/publisher/src/dkg-publisher.ts` `assertionPromote` that
    // excludes both `urn:dkg:file:` and `urn:dkg:extraction:` subjects
    // from the partition before `autoPartition` runs. Row 1 (whose
    // subject is the doc entity, not the file URN) is preserved through
    // promote; rows 4-13 are WM-only by design. See Codex Bug 8 Round 4
    // reconciled ruling — Round 3 tried blank-node subjects, but an
    // `autoPartition` audit showed they silently drop the prov block on
    // promote, which was a correctness smell. See `19_MARKDOWN_CONTENT_TYPE.md
    // §10.2` for the normative rule.
    const fileUri = `urn:dkg:file:${fileStoreEntry.keccak256}`;
    const provUri = `urn:dkg:extraction:${randomUUID()}`;
    const agentDid = `did:dkg:agent:${agent.peerId}`;

    // ── Phase 2: markdown → triples + linkage ──
    let triples;
    let sourceFileLinkage;
    let resolvedRootEntity: string;
    try {
      // The extractor owns rows 1 and 3. Row 2 (dkg:sourceContentType) is
      // daemon-owned — it must describe the ORIGINAL upload blob (row 1's
      // target), not the markdown intermediate the extractor processes.
      // Only the daemon has `detectedContentType` here, so it emits row 2
      // itself below alongside the file descriptor block.
      const result = extractFromMarkdown({
        markdown: mdIntermediate,
        agentDid,
        ontologyRef,
        documentIri: assertionUri,
        sourceFileIri: fileUri,
      });
      triples = result.triples;
      // Round 13 Bug 39: `provenance` renamed to `sourceFileLinkage`.
      // The old name conflicted with its original extraction-run
      // metadata semantic, which was moved to daemon-owned rows 9-13
      // (on the `<urn:dkg:extraction:uuid>` subject) in Round 9 Bug 27.
      // The extractor now only emits rows 1 and 3 of the source-file
      // linkage block, so the field's name reflects that directly.
      sourceFileLinkage = result.sourceFileLinkage;
      // §19.10.1:508 precedence: frontmatter `rootEntity` > explicit input >
      // reflexive subject. The extractor has already applied it to row 3;
      // reuse the resolved value for `_meta` row 14 below so row 3 and row
      // 14 are guaranteed to agree on the same root entity.
      resolvedRootEntity = result.resolvedRootEntity;
    } catch (err: any) {
      // Bug 13 + Round 7 Bug 20: invalid frontmatter IRIs AND invalid
      // programmatic `rootEntityIri` / `sourceFileIri` inputs both
      // throw from the extractor with a clear message. Surface as a
      // 400 so the user sees it immediately rather than a generic 500.
      const message = err?.message ?? String(err);
      if (
        message.includes('Invalid frontmatter')
        || message.includes("Invalid 'rootEntityIri'")
        || message.includes("Invalid 'sourceFileIri'")
      ) {
        return respondWithFailedExtraction(400, message, 0);
      }
      return respondWithFailedExtraction(500, `Phase 2 extraction failed: ${message}`, 0);
    }

    // ── Build the full quad set for both graphs (atomic single insert) ──
    // We assemble rows 1-13 as data-graph quads + rows 14-20 as CG root
    // `_meta` quads, each with its own explicit `graph` field, and commit
    // them all in ONE `agent.store.insert(...)` call. Every supported
    // triple-store adapter (oxigraph, blazegraph, sparql-http) implements
    // `insert` as a single N-Quads load / `INSERT DATA` operation, so the
    // call is naturally atomic across graphs: either every row lands or
    // none does. This replaces the earlier two-call flow
    // (`assertion.write` + `store.insert`) which had a window where rows
    // 1-13 could commit and rows 14-20 fail, leaving dangling data.
    //
    // `assertion.create` still runs first to register the assertion graph
    // container (idempotent on "already exists"). The write itself
    // bypasses `assertion.write` so the daemon can set per-quad graph
    // fields directly — `publisher.assertionWrite` hardcodes every quad to
    // the assertion graph URI, which defeats the multi-graph atomicity
    // we need here. Sub-graph registration is already validated by
    // `assertion.create`, so bypassing `assertion.write` doesn't skip any
    // safety checks.
    const assertionGraph = contextGraphAssertionUri(
      contextGraphId!,
      agent.peerId,
      assertionName,
      subGraphName,
    );
    const metaGraph = contextGraphMetaUri(contextGraphId!);
    const startedAtLiteral = `"${startedAt}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;

    // Data-graph quads: content (triples) + extractor linkage (provenance)
    // + daemon-owned rows 2, 4, 5, 8, 9-13. Every quad is pinned to the
    // assertion graph URI. `triples` and `provenance` come from the
    // extractor without a `graph` field, so we stamp each one here.
    //
    // Round 9 Bug 27: rows 6 (`dkg:fileName`) and 7 (`dkg:contentType`)
    // are REMOVED from the file descriptor block. `<fileUri>` is
    // content-addressed — two imports of identical bytes under different
    // filenames / upload content types would have written contradictory
    // facts to the same subject. Per-upload metadata now lives on the
    // assertion UAL in `_meta` (new row 15a: `dkg:sourceFileName`,
    // existing row 15: `dkg:sourceContentType` already there) where
    // per-assertion facts belong. Only intrinsic-to-content properties
    // (rdf:type, dkg:contentHash, dkg:size) remain on `<fileUri>` —
    // those are safe because they're derived purely from the blob bytes.
    // See `19_MARKDOWN_CONTENT_TYPE.md §10.2`.
    const dataGraphQuads = [
      ...triples.map(t => ({ ...t, graph: assertionGraph })),
      ...sourceFileLinkage.map(t => ({ ...t, graph: assertionGraph })),
      // Row 2 — daemon-owned. Describes the ORIGINAL upload blob (row 1's
      // target), so for a PDF upload this is "application/pdf" — NOT the
      // markdown intermediate the extractor processes. Extractor never
      // emits this row; the daemon is the single source of truth.
      { subject: assertionUri, predicate: 'http://dkg.io/ontology/sourceContentType', object: JSON.stringify(detectedContentType), graph: assertionGraph },
      // Row 4 — file descriptor block subject is the content-addressed URN
      { subject: fileUri, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/File', graph: assertionGraph },
      // Row 5 — on-chain canonical hash format is keccak256:<hex>
      { subject: fileUri, predicate: 'http://dkg.io/ontology/contentHash', object: JSON.stringify(fileStoreEntry.keccak256), graph: assertionGraph },
      // Row 8 — xsd:integer for size (byte count)
      { subject: fileUri, predicate: 'http://dkg.io/ontology/size', object: `"${fileStoreEntry.size}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: assertionGraph },
      // Row 9 — ExtractionProvenance subject is a fresh UUID URN per import
      { subject: provUri, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/ExtractionProvenance', graph: assertionGraph },
      // Row 10 — back-references the file URN (same value as rows 4-5, 8 subject)
      { subject: provUri, predicate: 'http://dkg.io/ontology/extractedFrom', object: fileUri, graph: assertionGraph },
      // Row 11
      { subject: provUri, predicate: 'http://dkg.io/ontology/extractedBy', object: agentDid, graph: assertionGraph },
      // Row 12
      { subject: provUri, predicate: 'http://dkg.io/ontology/extractedAt', object: startedAtLiteral, graph: assertionGraph },
      // Row 13
      { subject: provUri, predicate: 'http://dkg.io/ontology/extractionMethod', object: JSON.stringify('structural'), graph: assertionGraph },
    ];

    // `_meta` quads (rows 14-20): always land in the CG ROOT `_meta`, never
    // a sub-graph `_meta`, keyed by the assertion UAL so daemon restarts
    // can recover the file ↔ assertion linkage from the graph alone.
    const metaQuads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [
      // Row 14 — rootEntity comes from the extractor's resolved value so
      // the data-graph row 3 and `_meta` row 14 point at the same IRI.
      { subject: assertionUri, predicate: 'http://dkg.io/ontology/rootEntity', object: resolvedRootEntity, graph: metaGraph },
      // Row 15 — original content type from the upload (matches row 2
      // now that both rows are sourced from `detectedContentType`).
      { subject: assertionUri, predicate: 'http://dkg.io/ontology/sourceContentType', object: JSON.stringify(detectedContentType), graph: metaGraph },
      // Row 16 — load-bearing: lets a caller look up the source blob by UAL alone.
      { subject: assertionUri, predicate: 'http://dkg.io/ontology/sourceFileHash', object: JSON.stringify(fileStoreEntry.keccak256), graph: metaGraph },
      // Row 17
      { subject: assertionUri, predicate: 'http://dkg.io/ontology/extractionMethod', object: JSON.stringify('structural'), graph: metaGraph },
      // Row 18
      { subject: assertionUri, predicate: 'http://dkg.io/ontology/structuralTripleCount', object: `"${triples.length}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: metaGraph },
      // Row 19 — V10.0 has no semantic (Layer 2) extraction, so always zero.
      { subject: assertionUri, predicate: 'http://dkg.io/ontology/semanticTripleCount', object: `"0"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: metaGraph },
    ];
    // Row 20 — only emitted when Phase 1 actually ran (PDF/DOCX path).
    if (mdIntermediateHash) {
      metaQuads.push({
        subject: assertionUri,
        predicate: 'http://dkg.io/ontology/mdIntermediateHash',
        object: JSON.stringify(mdIntermediateHash),
        graph: metaGraph,
      });
    }
    // Round 9 Bug 27: `dkg:sourceFileName` — per-upload metadata that
    // used to live on `<fileUri>` (row 6 in the old file descriptor
    // block) moves to `_meta` keyed by `<assertionUri>` so two imports
    // of identical bytes under different filenames don't collide on
    // the same content-addressed subject. Symmetric to row 15
    // (`dkg:sourceContentType`). Skipped entirely when the upload
    // didn't carry a filename (matches the row 20 optional pattern).
    const uploadedFilename = filePart.filename?.trim() ?? '';
    if (uploadedFilename.length > 0) {
      metaQuads.push({
        subject: assertionUri,
        predicate: 'http://dkg.io/ontology/sourceFileName',
        object: JSON.stringify(uploadedFilename),
        graph: metaGraph,
      });
    }

    // Round 14 Bug 42: lock acquisition moved to the top of the
    // handler, before Phase 1/2 extraction. This inner `try` now
    // wraps only the assertion.create + snapshot + cleanup + insert
    // + rollback sequence. See the lock-acquisition site above for
    // the full rationale.
    try {
      // Ensure the assertion graph exists even when Phase 2 yields zero
      // content triples, so a completed import always materializes the
      // reported assertion URI. `assertion.create` also runs the sub-graph
      // registration check, so bypassing `assertion.write` below doesn't
      // skip that safety gate.
      try {
        await agent.assertion.create(
          contextGraphId!,
          assertionName,
          subGraphName ? { subGraphName } : undefined,
        );
      } catch (err: any) {
        const message = err?.message ?? String(err);
        if (message.includes('already exists') || message.includes('duplicate') || message.includes('conflict')) {
          // create() is idempotent when the graph already exists.
        } else if (
          message.includes('has not been registered')
          || message.includes('Invalid')
          || message.includes('Unsafe')
        ) {
          return respondWithFailedExtraction(400, message, triples.length);
        } else {
          return respondWithFailedExtraction(500, message, triples.length);
        }
      }

      // ── Snapshot BOTH graphs for Bugs 11 + 15 rollback ──
      //
      // Before the destructive cleanup (dropGraph + deleteByPattern),
      // CONSTRUCT the current contents of BOTH the assertion data graph
      // AND the assertion's `_meta` rows so the rollback path can
      // restore either or both if the subsequent atomic `store.insert`
      // fails.
      //
      // Round 4 (Bug 11) added the data-graph snapshot but NOT the
      // `_meta` snapshot, which left an edge case: a transient insert
      // failure would restore the prior data graph but leave `_meta`
      // empty for this assertion. Codex Bug 15 called that out — the
      // old `sourceFileHash` / `rootEntity` rows need to come back too.
      //
      // The data-graph CONSTRUCT pulls every quad where the assertion
      // graph is the context. The `_meta` CONSTRUCT is scoped to the
      // `<assertionUal> ?p ?o` subject pattern inside the CG root
      // `_meta` graph — we only rollback rows keyed by THIS assertion,
      // not every row in the shared `_meta` graph.
      //
      // First-import case: both CONSTRUCTs return zero quads (nothing
      // to preserve), and the rollback path is a no-op on both sides.
      let dataSnapshot: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];
      let metaSnapshot: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];
      try {
        const dataResult = await agent.store.query(
          `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`,
        );
        if (dataResult.type === 'quads') {
          // Pin the graph field to the assertion graph URI — CONSTRUCT
          // result quads have graph="" by adapter convention, but the
          // rollback re-insert needs to target the original graph.
          dataSnapshot = dataResult.quads.map(q => ({ ...q, graph: assertionGraph }));
        }
      } catch (err: any) {
        const message = err?.message ?? String(err);
        // Round 13 Bug 38: mark the error so the outer catch doesn't
        // overwrite this stage-specific failure record with the raw
        // store error. Callers reading `/extraction-status` see
        // "Failed to snapshot assertion data graph for rollback: ..."
        // which tells them WHICH stage of the import pipeline broke,
        // not just the underlying store error in isolation.
        recordFailedExtraction(`Failed to snapshot assertion data graph for rollback: ${message}`, 0);
        (err as any).__failureAlreadyRecorded = true;
        throw err;
      }
      try {
        const metaResult = await agent.store.query(
          `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`,
        );
        if (metaResult.type === 'quads') {
          // Same graph-field pinning as above — preserve `metaGraph`
          // on every snapshotted quad so the rollback re-insert targets
          // the CG root `_meta` graph, not the empty default graph.
          metaSnapshot = metaResult.quads.map(q => ({ ...q, graph: metaGraph }));
        }
      } catch (err: any) {
        const message = err?.message ?? String(err);
        // Round 13 Bug 38: same stage-context preservation as the
        // dataSnapshot failure branch above.
        recordFailedExtraction(`Failed to snapshot _meta for rollback: ${message}`, 0);
        (err as any).__failureAlreadyRecorded = true;
        throw err;
      }

      // ── Clear stale content from BOTH graphs before the fresh insert ──
      //
      // import-file has REPLACE semantics on same-name re-import: the
      // assertion ends up with exactly the content of the latest upload,
      // not a merge of every prior upload. Without this cleanup:
      //
      // 1. `_meta` rows 14-20 keyed by `<assertionUal>` would stack a
      //    second block next to the old one, so
      //    `<assertionUal> dkg:sourceFileHash ?h` would return two
      //    different hashes with no way to tell which is canonical.
      //
      // 2. Data-graph rows 1 and 4-13 would leave the old blob's
      //    descriptor next to the new blob's — a consumer walking the
      //    assertion graph would see two source files for one assertion.
      //
      // Order (Bug 14 reorder): `_meta` cleanup runs FIRST, then
      // `dropGraph`. This matches the Bug 12 pattern in
      // `assertionDiscard`. Both primitives are idempotent:
      // `deleteByPattern` returns 0 on a fresh assertion, `dropGraph`
      // uses `DROP SILENT GRAPH` so it's a no-op on a missing graph.
      //
      // Round 7 Bug 22: the Round 5/6 rollback path only fired when
      // the atomic `store.insert` failed. If `dropGraph` failed AFTER
      // `deleteByPattern` succeeded, the old `_meta` rows were gone
      // and the old data graph was still intact — a self-inconsistent
      // state with no rollback. Track which cleanup steps succeeded
      // and, on ANY subsequent failure, restore whichever snapshots
      // correspond to state we actually corrupted:
      //
      //  - `metaCleanupSucceeded` → restore `metaSnapshot`
      //  - `dataDropSucceeded` → restore `dataSnapshot`
      //  - insert succeeded → no rollback
      //  - `deleteByPattern` itself failed → no rollback (nothing
      //    changed, retry converges cleanly)
      //
      // The rollback is best-effort: compound failures record a rich
      // error with every failure message, then rethrow the ORIGINAL
      // error so the 500 envelope matches what the caller experienced.
      let metaCleanupSucceeded = false;
      let dataDropSucceeded = false;
      try {
        await agent.store.deleteByPattern({ subject: assertionUri, graph: metaGraph });
        metaCleanupSucceeded = true;
        await agent.store.dropGraph(assertionGraph);
        dataDropSucceeded = true;
        // ── Atomic multi-graph insert: rows 1-13 + rows 14-20 in one call ──
        // A single `store.insert` across two graphs — either both
        // land or neither does, per the adapter contracts.
        await agent.store.insert([...dataGraphQuads, ...metaQuads]);
      } catch (writeErr: any) {
        const writeMsg = writeErr?.message ?? String(writeErr);
        const rollbackErrors: string[] = [];
        // Restore each side we corrupted, in reverse order of the
        // forward sequence (insert → dropGraph → deleteByPattern).
        // `dataSnapshot` is restored only if `dropGraph` succeeded
        // (before then the old data is still in the store); likewise
        // `metaSnapshot` is restored only if `deleteByPattern`
        // succeeded. On a `deleteByPattern`-only failure both flags
        // are false and no rollback fires — the state is unchanged.
        if (dataDropSucceeded && dataSnapshot.length > 0) {
          try {
            await agent.store.insert(dataSnapshot);
          } catch (dataRollbackErr: any) {
            rollbackErrors.push(`data rollback failed: ${dataRollbackErr?.message ?? dataRollbackErr}`);
          }
        }
        if (metaCleanupSucceeded && metaSnapshot.length > 0) {
          try {
            await agent.store.insert(metaSnapshot);
          } catch (metaRollbackErr: any) {
            rollbackErrors.push(`_meta rollback failed: ${metaRollbackErr?.message ?? metaRollbackErr}`);
          }
        }
        if (rollbackErrors.length > 0) {
          // One or both rollback re-inserts failed. Log the compound
          // failure with every error message so a human can diagnose
          // the state, then rethrow the original error so the
          // top-level 500 handler responds with the envelope that
          // matches what the caller actually experienced.
          recordFailedExtraction(
            `write stage failed AND rollback failures: ${writeMsg}; ${rollbackErrors.join('; ')}`,
            triples.length,
          );
          (writeErr as any).__failureAlreadyRecorded = true;
        }
        throw writeErr;
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      // Round 10 Bug 29: the previous `message.includes('Invalid' |
      // 'Unsafe' | 'has not been registered')` branches were moved
      // OUT of this outer catch. They now live only in the inner
      // `assertion.create` catch above (lines 2815-2828), which is
      // the only step in this block where a user-input validation
      // error can legitimately originate.
      //
      // The outer catch is only reachable for post-`assertion.create`
      // steps — snapshot queries, `_meta` cleanup, `dropGraph`, atomic
      // insert, and rollback re-inserts. Those all operate on
      // daemon-constructed quads and storage-layer primitives; an
      // `Invalid` or `Unsafe` substring in a thrown message from
      // those steps signals an INTERNAL storage error (e.g., an
      // Oxigraph `Invalid query plan` or a replication layer
      // `Unsafe write`), not a user-input failure. Misclassifying
      // them as HTTP 400 would mislead the caller into retrying
      // with a "fixed" payload when the problem was server-side.
      // Let them bubble up as 500 via the top-level handler.
      //
      // Bug 15: compound rollback failure already wrote a rich error
      // record — don't overwrite it with the bare insert error.
      if ((err as any)?.__failureAlreadyRecorded) {
        throw err;
      }
      // Unexpected write-stage failure: record the failure on the extraction
      // status map before rethrowing so /extraction-status doesn't stay stuck
      // at in_progress when the top-level 500 handler takes over. Because
      // the insert is atomic across both graphs, nothing landed and a retry
      // sees a clean slate.
      recordFailedExtraction(message, triples.length);
      throw err;
    }

    const completedRecord: ExtractionStatusRecord = {
      status: 'completed',
      fileHash: fileStoreEntry.keccak256,
      detectedContentType,
      pipelineUsed,
      tripleCount: triples.length,
      mdIntermediateHash,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    setExtractionStatusRecord(extractionStatus, assertionUri, completedRecord);

    return respondWithImportFileResponse(200, {
      status: 'completed',
      tripleCount: triples.length,
      pipelineUsed,
      ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
    });
    } finally {
      // Round 14 Bug 42 outer finally: release the per-assertion
      // lock so the next waiter can start. Runs regardless of
      // early returns (graceful-degrade skipped path, failed-
      // extraction paths, successful completion) AND regardless
      // of whether the inner write-stage try/catch threw. The map
      // entry is cleaned up iff this call is still the head of
      // the queue — if another waiter has chained on after us, its
      // chained promise has already replaced our slot in the map
      // and we leave it alone.
      releaseLock();
      if (assertionImportLocks.get(assertionUri) === chainedLock) {
        assertionImportLocks.delete(assertionUri);
      }
    }
  }

  // GET /api/assertion/:name/extraction-status?contextGraphId=...&subGraphName=...
  // Returns the current extraction job state for the given assertion.
  // Synchronous extractions (V10.0 default) return status="completed" immediately
  // on the import-file response; this endpoint lets agents re-query the status
  // later without having to hold the import-file response, and provides the hook
  // for async extraction workflows in V10.x.
  if (req.method === 'GET' && path.startsWith('/api/assertion/') && path.endsWith('/extraction-status')) {
    const assertionName = safeDecodeURIComponent(path.slice('/api/assertion/'.length, -'/extraction-status'.length), res);
    if (assertionName === null) return;
    const nameVal = validateAssertionName(assertionName);
    if (!nameVal.valid) return jsonResponse(res, 400, { error: `Invalid assertion name: ${nameVal.reason}` });
    const contextGraphId = url.searchParams.get('contextGraphId') ?? url.searchParams.get('paranetId');
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    const subGraphName = url.searchParams.get('subGraphName') ?? undefined;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;

    const assertionUri = contextGraphAssertionUri(
      contextGraphId!,
      agent.peerId,
      assertionName,
      subGraphName,
    );
    const record = getExtractionStatusRecord(extractionStatus, assertionUri);
    if (!record) {
      return jsonResponse(res, 404, {
        error: `No extraction record found for assertion "${assertionName}" in context graph "${contextGraphId}"`,
      });
    }
    return jsonResponse(res, 200, {
      assertionUri,
      status: record.status,
      fileHash: record.fileHash,
      detectedContentType: record.detectedContentType,
      pipelineUsed: record.pipelineUsed,
      tripleCount: record.tripleCount,
      ...(record.mdIntermediateHash ? { mdIntermediateHash: record.mdIntermediateHash } : {}),
      ...(record.error ? { error: record.error } : {}),
      startedAt: record.startedAt,
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    });
  }

  // POST /api/shared-memory/conditional-write  { contextGraphId, quads, conditions, subGraphName? }
  if (req.method === 'POST' && path === '/api/shared-memory/conditional-write') {
    const body = await readBody(req);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { quads, conditions, subGraphName } = parsed;
    const paranetId = parsed.contextGraphId ?? parsed.paranetId;
    if (!quads?.length) return jsonResponse(res, 400, { error: 'Missing "quads"' });
    if (!validateRequiredContextGraphId(paranetId, res)) return;
    if (!validateConditions(conditions, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    const ctx = createOperationContext('share');
    tracker.start(ctx, { contextGraphId: paranetId, details: { tripleCount: quads.length, source: 'api-cas', subGraphName } });
    try {
      const result = await agent.conditionalShare(paranetId, quads, conditions, { subGraphName, operationCtx: ctx });
      tracker.complete(ctx, { tripleCount: quads.length });
      return jsonResponse(res, 200, { ok: true, shareOperationId: result?.shareOperationId });
    } catch (err: any) {
      tracker.fail(ctx, err);
      if (err.name === 'StaleWriteError' || err.message?.includes('stale') || err.message?.includes('CAS condition failed')) {
        return jsonResponse(res, 409, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/query  { sparql: "...", paranetId?: "...", graphSuffix?: "_shared_memory", includeWorkspace?: bool }
  if (req.method === 'POST' && path === '/api/query') {
    const serverT0 = Date.now();
    const body = await readBody(req);
    const parsed = JSON.parse(body);
    const sparql = parsed.sparql;
    const contextGraphId = parsed.contextGraphId ?? parsed.paranetId;
    const graphSuffix = parsed.graphSuffix;
    const includeSharedMemory = parsed.includeSharedMemory ?? parsed.includeWorkspace;
    const view = parsed.view;
    const agentAddress = parsed.agentAddress;
    const verifiedGraph = parsed.verifiedGraph;
    const assertionName = parsed.assertionName;
    const subGraphName = parsed.subGraphName;
    if (!sparql || !String(sparql).trim()) return jsonResponse(res, 400, { error: 'Missing "sparql"' });
    if (view && !(GET_VIEWS as readonly string[]).includes(view)) {
      return jsonResponse(res, 400, { error: `Invalid view "${view}". Supported: ${GET_VIEWS.join(', ')}` });
    }
    const ctx = createOperationContext('query');
    tracker.start(ctx, { contextGraphId, details: { sparql: sparql.slice(0, 200) } });
    tracker.startPhase(ctx, 'parse');
    try {
      tracker.completePhase(ctx, 'parse');
      tracker.startPhase(ctx, 'execute');
      const execT0 = Date.now();
      const result = await agent.query(sparql, { contextGraphId, graphSuffix, includeSharedMemory, view, agentAddress, verifiedGraph, assertionName, subGraphName, operationCtx: ctx });
      const execDur = Date.now() - execT0;
      tracker.completePhase(ctx, 'execute');
      tracker.complete(ctx, { tripleCount: result?.bindings?.length ?? 0 });
      return jsonResponse(res, 200, { result, phases: { execute: execDur, serverTotal: Date.now() - serverT0 } });
    } catch (err: any) {
      tracker.fail(ctx, err);
      const msg = err?.message ?? '';
      if (
        msg.startsWith('SPARQL rejected:') || msg.startsWith('Parse error') ||
        /must start with (SELECT|CONSTRUCT|ASK|DESCRIBE)/i.test(msg) ||
        msg.includes('was removed in V10') ||
        msg.includes('agentAddress is required') || msg.includes('requires a contextGraphId') ||
        msg.includes('cannot be combined with')
      ) {
        return jsonResponse(res, 400, { error: msg });
      }
      throw err;
    }
  }

  // POST /api/query-remote  { peerId, lookupType, paranetId?, ual?, entityUri?, rdfType?, sparql?, limit?, timeout? }
  if (req.method === 'POST' && path === '/api/query-remote') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { peerId: rawPeerId, lookupType, paranetId, ual, entityUri, rdfType, sparql, limit, timeout } = JSON.parse(body);
    if (!rawPeerId) return jsonResponse(res, 400, { error: 'Missing "peerId"' });
    if (!lookupType) return jsonResponse(res, 400, { error: 'Missing "lookupType"' });
    const ctx = createOperationContext('query');
    tracker.start(ctx, { contextGraphId: paranetId, details: { lookupType, remotePeer: rawPeerId, source: 'api-remote' } });
    try {
      const peerId = await tracker.trackPhase(ctx, 'resolve', () => resolveNameToPeerId(agent, rawPeerId));
      if (!peerId) {
        tracker.fail(ctx, new Error(`Agent "${rawPeerId}" not found`));
        return jsonResponse(res, 404, { error: `Agent "${rawPeerId}" not found` });
      }
      const response = await tracker.trackPhase(ctx, 'execute', () =>
        agent.queryRemote(peerId, { lookupType, paranetId, ual, entityUri, rdfType, sparql, limit, timeout }),
      );
      tracker.complete(ctx, { details: { lookupType, remotePeer: rawPeerId } });
      return jsonResponse(res, 200, response);
    } catch (err) {
      tracker.fail(ctx, err);
      throw err;
    }
  }

  // POST /api/context-graph/subscribe (V10) or /api/subscribe (legacy)
  if (req.method === 'POST' && (path === '/api/context-graph/subscribe' || path === '/api/subscribe')) {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = JSON.parse(body);
    const { includeWorkspace, includeSharedMemory } = parsed;
    const paranetId = parsed.contextGraphId ?? parsed.paranetId;
    if (!paranetId) return jsonResponse(res, 400, { error: 'Missing "contextGraphId" (or legacy "paranetId")' });
    const shouldSyncSharedMemory = (includeSharedMemory ?? includeWorkspace) !== false;
    agent.subscribeToContextGraph(paranetId);

    const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const job: CatchupJob = {
      jobId,
      paranetId,
      includeWorkspace: shouldSyncSharedMemory,
      status: 'queued',
      queuedAt: Date.now(),
    };
    catchupTracker.jobs.set(jobId, job);
    catchupTracker.latestByParanet.set(paranetId, jobId);

    while (catchupTracker.jobs.size > 100) {
      let oldestId: string | undefined;
      let oldestQueuedAt = Number.POSITIVE_INFINITY;
      for (const [id, entry] of catchupTracker.jobs.entries()) {
        if (entry.queuedAt < oldestQueuedAt) {
          oldestQueuedAt = entry.queuedAt;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      const removed = catchupTracker.jobs.get(oldestId);
      catchupTracker.jobs.delete(oldestId);
      if (removed && catchupTracker.latestByParanet.get(removed.paranetId) === oldestId) {
        catchupTracker.latestByParanet.delete(removed.paranetId);
      }
    }

    void (async () => {
      job.status = 'running';
      job.startedAt = Date.now();
      try {
        const result = await agent.syncContextGraphFromConnectedPeers(paranetId, {
          includeSharedMemory: shouldSyncSharedMemory,
        });
        job.result = result;
        job.status = 'done';
      } catch (err) {
        job.error = err instanceof Error ? err.message : String(err);
        job.status = 'failed';
      } finally {
        job.finishedAt = Date.now();
      }
    })();

    return jsonResponse(res, 200, {
      subscribed: paranetId,
      catchup: {
        status: 'queued',
        includeWorkspace: shouldSyncSharedMemory,
        jobId,
      },
    });
  }

  // GET /api/sync/catchup-status?contextGraphId=<id> | ?paranetId=<id> | ?jobId=<id>
  if (req.method === 'GET' && path === '/api/sync/catchup-status') {
    const paranetId = url.searchParams.get('contextGraphId') ?? url.searchParams.get('paranetId');
    const jobIdParam = url.searchParams.get('jobId');
    if (!paranetId && !jobIdParam) {
      return jsonResponse(res, 400, { error: 'Missing "contextGraphId" (or "paranetId") or "jobId" query param' });
    }

    const jobId = jobIdParam ?? (paranetId ? catchupTracker.latestByParanet.get(paranetId) : undefined);
    if (!jobId) {
      return jsonResponse(res, 404, { error: 'No catch-up job found' });
    }
    const job = catchupTracker.jobs.get(jobId);
    if (!job) {
      return jsonResponse(res, 404, { error: `Catch-up job "${jobId}" not found` });
    }

    return jsonResponse(res, 200, job);
  }

  // POST /api/paranet/create (legacy) — create a context graph definition
  // V10 route /api/context-graph/create is handled above (combined with on-chain context graph create).
  if (req.method === 'POST' && path === '/api/paranet/create') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { id, name, description } = JSON.parse(body);
    if (!id || !name) return jsonResponse(res, 400, { error: 'Missing "id" or "name"' });
    await agent.createContextGraph({ id, name, description });
    return jsonResponse(res, 200, { created: id, uri: `did:dkg:context-graph:${id}` });
  }

  // GET /api/context-graph/list (V10) or /api/paranet/list (legacy)
  if (req.method === 'GET' && (path === '/api/context-graph/list' || path === '/api/paranet/list')) {
    const contextGraphs = await agent.listContextGraphs();
    return jsonResponse(res, 200, {
      contextGraphs,
      paranets: contextGraphs, // backward compat
    });
  }

  // GET /api/integrations — aggregated view for Integrations panel (adapters, skills, context graphs)
  if (req.method === 'GET' && path === '/api/integrations') {
    const [skills, paranets] = await Promise.all([agent.findSkills(), agent.listContextGraphs()]);
    const adapters = [
      { id: 'elizaos', name: 'ElizaOS', enabled: true, description: 'Connect to ElizaOS agents' },
      { id: 'openclaw', name: 'OpenClaw', enabled: true, description: 'OpenClaw framework adapter' },
    ];
    return jsonResponse(res, 200, { adapters, skills, paranets });
  }

  // POST /api/register-adapter — adapter self-registers so UI can detect it
  if (req.method === 'POST' && path === '/api/register-adapter') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }
    const { id } = parsed;
    if (typeof id !== 'string' || id !== 'openclaw') {
      return jsonResponse(res, 400, { error: `Unknown adapter id: ${String(id)}` });
    }
    if (!config.openclawAdapter) {
      config.openclawAdapter = true;
      await saveConfig(config);
    }
    return jsonResponse(res, 200, { ok: true });
  }

  // GET /api/context-graph/exists (V10) or /api/paranet/exists (legacy)
  if (req.method === 'GET' && (path === '/api/context-graph/exists' || path === '/api/paranet/exists')) {
    const id = url.searchParams.get('id');
    if (!id) return jsonResponse(res, 400, { error: 'Missing "id" query param' });
    const exists = await agent.contextGraphExists(id);
    return jsonResponse(res, 200, { id, exists });
  }

  // POST /api/verify
  if (req.method === 'POST' && path === '/api/verify') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { contextGraphId, verifiedMemoryId, batchId, timeoutMs, requiredSignatures } = JSON.parse(body);
    if (!contextGraphId || !verifiedMemoryId || !batchId) {
      return jsonResponse(res, 400, { error: 'Missing contextGraphId, verifiedMemoryId, or batchId' });
    }
    const parsedSigs = parseRequiredSignatures(requiredSignatures);
    if ('error' in parsedSigs) {
      return jsonResponse(res, 400, { error: parsedSigs.error });
    }
    const validatedRequiredSigs = parsedSigs.value || undefined;
    const result = await agent.verify({
      contextGraphId,
      verifiedMemoryId,
      batchId: BigInt(batchId),
      timeoutMs: timeoutMs ? Number(timeoutMs) : undefined,
      requiredSignatures: validatedRequiredSigs,
    });
    return jsonResponse(res, 200, { ...result, batchId: String(batchId) });
  }

  // POST /api/endorse
  if (req.method === 'POST' && path === '/api/endorse') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { contextGraphId, ual, agentAddress } = JSON.parse(body);
    if (!contextGraphId || !ual || !agentAddress) {
      return jsonResponse(res, 400, { error: 'Missing contextGraphId, ual, or agentAddress' });
    }
    const result = await agent.endorse({ contextGraphId, knowledgeAssetUal: ual, agentAddress });
    return jsonResponse(res, 200, { endorsed: true, endorserAddress: agentAddress, ...result });
  }

  // POST /api/ccl/policy/publish
  if (req.method === 'POST' && path === '/api/ccl/policy/publish') {
    const body = await readBody(req, SMALL_BODY_BYTES * 4);
    const { paranetId, name, version, content, description, contextType, language, format } = JSON.parse(body);
    if (!paranetId || !name || !version || !content) {
      return jsonResponse(res, 400, { error: 'Missing required fields: paranetId, name, version, content' });
    }
    const result = await agent.publishCclPolicy({ paranetId, name, version, content, description, contextType, language, format });
    return jsonResponse(res, 200, result);
  }

  // POST /api/ccl/policy/approve
  if (req.method === 'POST' && path === '/api/ccl/policy/approve') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { paranetId, policyUri, contextType } = JSON.parse(body);
    if (!paranetId || !policyUri) {
      return jsonResponse(res, 400, { error: 'Missing required fields: paranetId, policyUri' });
    }
    const result = await agent.approveCclPolicy({ paranetId, policyUri, contextType });
    return jsonResponse(res, 200, result);
  }

  // POST /api/ccl/policy/revoke
  if (req.method === 'POST' && path === '/api/ccl/policy/revoke') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { paranetId, policyUri, contextType } = JSON.parse(body);
    if (!paranetId || !policyUri) {
      return jsonResponse(res, 400, { error: 'Missing required fields: paranetId, policyUri' });
    }
    const result = await agent.revokeCclPolicy({ paranetId, policyUri, contextType });
    return jsonResponse(res, 200, result);
  }

  // GET /api/ccl/policy/list
  if (req.method === 'GET' && path === '/api/ccl/policy/list') {
    const policies = await agent.listCclPolicies({
      paranetId: url.searchParams.get('paranetId') ?? undefined,
      name: url.searchParams.get('name') ?? undefined,
      contextType: url.searchParams.get('contextType') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      includeBody: url.searchParams.get('includeBody') === 'true',
    });
    return jsonResponse(res, 200, { policies });
  }

  // GET /api/ccl/policy/resolve?paranetId=&name=&contextType=
  if (req.method === 'GET' && path === '/api/ccl/policy/resolve') {
    const paranetId = url.searchParams.get('paranetId');
    const name = url.searchParams.get('name');
    if (!paranetId || !name) {
      return jsonResponse(res, 400, { error: 'Missing required query params: paranetId, name' });
    }
    const policy = await agent.resolveCclPolicy({
      paranetId,
      name,
      contextType: url.searchParams.get('contextType') ?? undefined,
      includeBody: url.searchParams.get('includeBody') === 'true',
    });
    return jsonResponse(res, 200, { policy });
  }

  // POST /api/ccl/eval
  if (req.method === 'POST' && path === '/api/ccl/eval') {
    const body = await readBody(req, SMALL_BODY_BYTES * 8);
    const { paranetId, name, facts, contextType, view, snapshotId, scopeUal, publishResult } = JSON.parse(body);
    if (!paranetId || !name) {
      return jsonResponse(res, 400, { error: 'Missing required fields: paranetId, name' });
    }
    if (facts != null && !Array.isArray(facts)) {
      return jsonResponse(res, 400, { error: 'facts must be an array when provided' });
    }
    const result = publishResult
      ? await agent.evaluateAndPublishCclPolicy({ paranetId, name, facts, contextType, view, snapshotId, scopeUal })
      : await agent.evaluateCclPolicy({ paranetId, name, facts, contextType, view, snapshotId, scopeUal });
    return jsonResponse(res, 200, result);
  }

  // GET /api/ccl/results?paranetId=&...
  if (req.method === 'GET' && path === '/api/ccl/results') {
    const paranetId = url.searchParams.get('paranetId');
    if (!paranetId) {
      return jsonResponse(res, 400, { error: 'Missing required query param: paranetId' });
    }
    const evaluations = await agent.listCclEvaluations({
      paranetId,
      policyUri: url.searchParams.get('policyUri') ?? undefined,
      snapshotId: url.searchParams.get('snapshotId') ?? undefined,
      view: url.searchParams.get('view') ?? undefined,
      contextType: url.searchParams.get('contextType') ?? undefined,
      resultKind: (url.searchParams.get('resultKind') as 'derived' | 'decision' | null) ?? undefined,
      resultName: url.searchParams.get('resultName') ?? undefined,
    });
    return jsonResponse(res, 200, { evaluations });
  }

  // GET /api/wallets (list addresses only)
  if (req.method === 'GET' && (path === '/api/wallet' || path === '/api/wallets')) {
    return jsonResponse(res, 200, {
      wallets: opWallets.wallets.map((w) => w.address),
      chainId: (config.chain ?? network?.chain)?.chainId,
    });
  }

  // GET /api/wallets/balances — ETH + TRAC per wallet, RPC health
  if (req.method === 'GET' && path === '/api/wallets/balances') {
    const chain = config.chain ?? network?.chain;
    const rpcUrl = chain?.rpcUrl;
    const hubAddress = chain?.hubAddress;
    const chainId = chain?.chainId ?? null;
    if (!rpcUrl || !hubAddress || !opWallets.wallets.length) {
      return jsonResponse(res, 200, {
        wallets: [],
        balances: [],
        chainId,
        rpcUrl: rpcUrl ?? null,
        error: !rpcUrl || !hubAddress ? 'Chain not configured' : 'No wallets',
      });
    }
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const hub = new ethers.Contract(hubAddress, ['function getContractAddress(string) view returns (address)'], provider);
      const tokenAddr = await hub.getContractAddress('Token').catch(() => null);
      let token: ethers.Contract | null = null;
      let tokenSymbol = 'TRAC';
      if (tokenAddr && tokenAddr !== ethers.ZeroAddress) {
        token = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)'], provider);
        tokenSymbol = await token.symbol().catch(() => 'TRAC');
      }
      const balances: Array<{ address: string; eth: string; trac: string; symbol: string }> = [];
      for (const w of opWallets.wallets) {
        const ethBal = await provider.getBalance(w.address);
        const tracBal = token ? await token.balanceOf(w.address) : 0n;
        balances.push({
          address: w.address,
          eth: ethers.formatEther(ethBal),
          trac: ethers.formatEther(tracBal),
          symbol: tokenSymbol,
        });
      }
      return jsonResponse(res, 200, { wallets: opWallets.wallets.map((w) => w.address), balances, chainId, rpcUrl, symbol: tokenSymbol });
    } catch (err: any) {
      return jsonResponse(res, 200, { wallets: opWallets.wallets.map((w) => w.address), balances: [], chainId, rpcUrl, error: err.message });
    }
  }

  // GET /api/chain/rpc-health
  if (req.method === 'GET' && path === '/api/chain/rpc-health') {
    const chain = config.chain ?? network?.chain;
    const rpcUrl = chain?.rpcUrl;
    if (!rpcUrl) {
      return jsonResponse(res, 200, { ok: false, rpcUrl: null, latencyMs: null, blockNumber: null, error: 'Chain not configured' });
    }
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const start = Date.now();
      const blockNumber = await provider.getBlockNumber();
      const latencyMs = Date.now() - start;
      return jsonResponse(res, 200, { ok: true, rpcUrl, latencyMs, blockNumber });
    } catch (err: any) {
      return jsonResponse(res, 200, { ok: false, rpcUrl, latencyMs: null, blockNumber: null, error: err.message });
    }
  }

  // GET /api/identity — current on-chain identity status
  if (req.method === 'GET' && path === '/api/identity') {
    const identityId = agent.publisher.getIdentityId();
    return jsonResponse(res, 200, {
      identityId: String(identityId),
      hasIdentity: identityId > 0n,
    });
  }

  // POST /api/identity/ensure — (re)attempt on-chain identity creation
  if (req.method === 'POST' && path === '/api/identity/ensure') {
    try {
      const identityId = await agent.ensureIdentity();
      return jsonResponse(res, 200, {
        identityId: String(identityId),
        hasIdentity: identityId > 0n,
      });
    } catch (err: any) {
      return jsonResponse(res, 500, { error: err.message, identityId: '0', hasIdentity: false });
    }
  }

  // POST /api/shutdown
  if (req.method === 'POST' && path === '/api/shutdown') {
    jsonResponse(res, 200, { ok: true });
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);
    return;
  }

  // GET /api/epcis/events?epc=...&bizStep=...&from=...&to=...&limit=100&offset=0
  if (req.method === 'GET' && path === '/api/epcis/events') {
    const epcisContextGraphId = config.epcis?.contextGraphId ?? config.epcis?.paranetId;
    if (!epcisContextGraphId) {
      return jsonResponse(res, 503, { error: 'EPCIS plugin is not configured (missing epcis.contextGraphId in config)' });
    }
    const searchParams = new URL(req.url!, `http://${req.headers.host}`).searchParams;
    const epcisQueryEngine = {
      query: (sparql: string, opts?: { contextGraphId?: string }) => agent.query(sparql, opts),
    };
    try {
      const result = await handleEventsQuery(searchParams, {
        contextGraphId: epcisContextGraphId,
        queryEngine: epcisQueryEngine,
        basePath: '/api/epcis/events',
      });
      if (result.headers?.link) {
        res.setHeader('Link', result.headers.link);
      }
      return jsonResponse(res, 200, result.body);
    } catch (err) {
      if (err instanceof EpcisQueryError) {
        return jsonResponse(res, err.statusCode, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/epcis/capture  { epcisDocument: {...}, publishOptions?: { accessPolicy? } }
  if (req.method === 'POST' && path === '/api/epcis/capture') {
    const captureContextGraphId = config.epcis?.contextGraphId ?? config.epcis?.paranetId;
    if (!captureContextGraphId) {
      return jsonResponse(res, 503, { error: 'EPCIS plugin is not configured (missing epcis.contextGraphId in config)' });
    }
    const body = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid JSON in request body' });
    }
    const { epcisDocument, publishOptions } = parsed;
    if (!epcisDocument) {
      return jsonResponse(res, 400, { error: 'Missing "epcisDocument" in request body' });
    }
    const epcisPublisher: EpcisPublisher = {
      async publish(contextGraphId, content, opts) {
        const result = await agent.publish(
          contextGraphId,
          { public: content } as Record<string, unknown>,
          opts,
        );
        return { ual: result.ual, kcId: String(result.kcId), status: result.status };
      },
    };
    try {
      const result = await handleCapture(
        { epcisDocument, publishOptions },
        { contextGraphId: captureContextGraphId, publisher: epcisPublisher },
      );
      // TODO: EPCIS 2.0 §12.6.1 requires 202 Accepted + captureID for async job tracking.
      // Current sync model returns 200 with the full result. Switch to 202 + captureID +
      // GET /capture/{captureID} polling endpoint when async capture is implemented (Phase 2).
      return jsonResponse(res, 200, result);
    } catch (err) {
      if (err instanceof EpcisValidationError) {
        return jsonResponse(res, 400, { error: err.message, details: err.errors });
      }
      throw err;
    }
  }

  jsonResponse(res, 404, { error: 'Not found' });
}

async function resolveNameToPeerId(agent: DKGAgent, nameOrId: string): Promise<string | null> {
  // If it looks like a PeerId already (starts with 12D3 or 16Uiu), return as-is
  if (nameOrId.startsWith('12D3') || nameOrId.startsWith('16Uiu') || nameOrId.length > 40) {
    return nameOrId;
  }

  const agents = await agent.findAgents();
  const lower = nameOrId.toLowerCase();
  const match = agents.find(a =>
    a.name.toLowerCase() === lower ||
    a.name.toLowerCase().startsWith(lower),
  );
  return match?.peerId ?? null;
}

function isPublishQuad(value: unknown): value is PublishQuad {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.subject === 'string' &&
    typeof v.predicate === 'string' &&
    typeof v.object === 'string' &&
    typeof v.graph === 'string'
  );
}

function parsePublishRequestBody(body: string):
  | { ok: true; value: PublishRequestBody }
  | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: 'Invalid JSON body' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Body must be a JSON object' };
  }

  const payload = parsed as Record<string, unknown>;
  const { quads, privateQuads, accessPolicy, allowedPeers, subGraphName } = payload;
  const paranetId = (payload.contextGraphId ?? payload.paranetId) as unknown;

  if (typeof paranetId !== 'string' || paranetId.trim().length === 0) {
    return { ok: false, error: 'Missing or invalid "contextGraphId" (or legacy "paranetId")' };
  }

  if (!Array.isArray(quads) || quads.length === 0 || !quads.every(isPublishQuad)) {
    return { ok: false, error: 'Missing or invalid "quads" (must be a non-empty quad array)' };
  }

  if (privateQuads !== undefined && (!Array.isArray(privateQuads) || !privateQuads.every(isPublishQuad))) {
    return { ok: false, error: 'Invalid "privateQuads" (must be a quad array)' };
  }

  if (accessPolicy !== undefined && accessPolicy !== 'public' && accessPolicy !== 'ownerOnly' && accessPolicy !== 'allowList') {
    return { ok: false, error: 'Invalid "accessPolicy" (must be public, ownerOnly, or allowList)' };
  }

  if (allowedPeers !== undefined && (!Array.isArray(allowedPeers) || !allowedPeers.every((p) => typeof p === 'string' && p.trim().length > 0))) {
    return { ok: false, error: 'Invalid "allowedPeers" (must be an array of non-empty strings)' };
  }

  if (accessPolicy === 'allowList' && (!allowedPeers || allowedPeers.length === 0)) {
    return { ok: false, error: '"allowList" accessPolicy requires non-empty "allowedPeers"' };
  }

  if (accessPolicy !== 'allowList' && allowedPeers && allowedPeers.length > 0) {
    return { ok: false, error: '"allowedPeers" is only valid when "accessPolicy" is "allowList"' };
  }

  if (subGraphName !== undefined) {
    if (typeof subGraphName !== 'string' || subGraphName.trim().length === 0) {
      return { ok: false, error: 'Invalid "subGraphName" (must be a non-empty string)' };
    }
    const sgValidation = validateSubGraphName(subGraphName);
    if (!sgValidation.valid) {
      return { ok: false, error: `Invalid "subGraphName": ${sgValidation.reason}` };
    }
  }

  return {
    ok: true,
    value: {
      paranetId,
      quads,
      privateQuads,
      accessPolicy,
      allowedPeers,
      subGraphName: subGraphName as string | undefined,
    },
  };
}


function jsonResponse(res: ServerResponse, status: number, data: unknown, corsOrigin?: string | null): void {
  const origin = corsOrigin !== undefined ? corsOrigin : ((res as any).__corsOrigin as string | null ?? null);
  const body = JSON.stringify(data, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...corsHeaders(origin),
  });
  res.end(body);
}

function safeDecodeURIComponent(encoded: string, res: ServerResponse): string | null {
  try {
    return decodeURIComponent(encoded);
  } catch {
    jsonResponse(res, 400, { error: 'Malformed percent-encoding in URL path' });
    return null;
  }
}

function safeParseJson(body: string, res: ServerResponse): Record<string, any> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON in request body' });
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    jsonResponse(res, 400, { error: 'Request body must be a JSON object' });
    return null;
  }
  return parsed as Record<string, any>;
}

function validateOptionalSubGraphName(subGraphName: unknown, res: ServerResponse): boolean {
  if (subGraphName === undefined || subGraphName === null) return true;
  if (typeof subGraphName === 'string' && subGraphName === '') {
    jsonResponse(res, 400, { error: 'subGraphName must be a non-empty string (omit the field for root graph)' });
    return false;
  }
  if (typeof subGraphName !== 'string') {
    jsonResponse(res, 400, { error: 'subGraphName must be a string' });
    return false;
  }
  const v = validateSubGraphName(subGraphName);
  if (!v.valid) {
    jsonResponse(res, 400, { error: `Invalid "subGraphName": ${v.reason}` });
    return false;
  }
  return true;
}

function validateRequiredContextGraphId(contextGraphId: unknown, res: ServerResponse): boolean {
  if (!contextGraphId) {
    jsonResponse(res, 400, { error: 'Missing "contextGraphId"' });
    return false;
  }
  if (typeof contextGraphId !== 'string') {
    jsonResponse(res, 400, { error: '"contextGraphId" must be a string' });
    return false;
  }
  const v = validateContextGraphId(contextGraphId);
  if (!v.valid) {
    jsonResponse(res, 400, { error: `Invalid "contextGraphId": ${v.reason}` });
    return false;
  }
  return true;
}

function validateEntities(entities: unknown, res: ServerResponse): boolean {
  if (entities === undefined || entities === null || entities === 'all') return true;
  if (typeof entities === 'string') {
    jsonResponse(res, 400, { error: '"entities" must be "all" or an array of entity URIs' });
    return false;
  }
  if (!Array.isArray(entities) || entities.length === 0 || !entities.every((e: unknown) => typeof e === 'string' && e.length > 0)) {
    jsonResponse(res, 400, { error: '"entities" must be "all" or a non-empty array of non-empty strings' });
    return false;
  }
  return true;
}

function validateConditions(conditions: unknown, res: ServerResponse): boolean {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    jsonResponse(res, 400, { error: '"conditions" must be a non-empty array (use /api/shared-memory/write for unconditional writes)' });
    return false;
  }
  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i];
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      jsonResponse(res, 400, { error: `conditions[${i}] must be an object` });
      return false;
    }
    if (typeof c.subject !== 'string' || c.subject.length === 0) {
      jsonResponse(res, 400, { error: `conditions[${i}].subject must be a non-empty string` });
      return false;
    }
    if (!isSafeIri(c.subject)) {
      jsonResponse(res, 400, { error: `conditions[${i}].subject contains characters unsafe for SPARQL IRIs` });
      return false;
    }
    if (typeof c.predicate !== 'string' || c.predicate.length === 0) {
      jsonResponse(res, 400, { error: `conditions[${i}].predicate must be a non-empty string` });
      return false;
    }
    if (!isSafeIri(c.predicate)) {
      jsonResponse(res, 400, { error: `conditions[${i}].predicate contains characters unsafe for SPARQL IRIs` });
      return false;
    }
    if (!('expectedValue' in c)) {
      jsonResponse(res, 400, { error: `conditions[${i}].expectedValue is required (use null for "must not exist")` });
      return false;
    }
    if (c.expectedValue !== null && typeof c.expectedValue !== 'string') {
      jsonResponse(res, 400, { error: `conditions[${i}].expectedValue must be a string or null` });
      return false;
    }
  }
  return true;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB — default for data-heavy endpoints (publish, update)
const SMALL_BODY_BYTES = 256 * 1024; // 256 KB — for settings, connect, chat, and other small payloads
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB — for import-file document uploads (PDFs, DOCX, etc.)

/**
 * In-memory extraction job tracking record. Populated at import-file time
 * and queried by the extraction-status endpoint. Records are kept in a
 * bounded, TTL-pruned map keyed by the target assertion URI (which is
 * unique per agent × contextGraph × assertionName × subGraphName).
 */
interface ImportFileExtractionPayload {
  status: 'completed' | 'skipped' | 'failed';
  tripleCount: number;
  pipelineUsed: string | null;
  mdIntermediateHash?: string;
  error?: string;
}

function buildImportFileResponse(args: {
  assertionUri: string;
  fileHash: string;
  detectedContentType: string;
  extraction: ImportFileExtractionPayload;
}) {
  return {
    assertionUri: args.assertionUri,
    fileHash: args.fileHash,
    detectedContentType: args.detectedContentType,
    extraction: {
      status: args.extraction.status,
      tripleCount: args.extraction.tripleCount,
      pipelineUsed: args.extraction.pipelineUsed,
      ...(args.extraction.mdIntermediateHash ? { mdIntermediateHash: args.extraction.mdIntermediateHash } : {}),
      ...(args.extraction.error ? { error: args.extraction.error } : {}),
    },
  };
}

function unregisteredSubGraphError(contextGraphId: string, subGraphName: string): string {
  return `Sub-graph "${subGraphName}" has not been registered in context graph "${contextGraphId}". Call createSubGraph() first.`;
}


function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    const onData = (c: Buffer) => {
      if (rejected) return;
      total += c.length;
      if (total > maxBytes) {
        rejected = true;
        req.removeListener('data', onData);
        req.resume();
        setTimeout(() => req.destroy(), 5_000); // close after giving time for 413 response
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks).toString()); });
    req.on('error', (err) => { if (!rejected) reject(err); });
  });
}

/**
 * Buffer variant of `readBody` that returns raw bytes. Use for binary payloads
 * like multipart/form-data uploads where `.toString()` would corrupt content.
 */
function readBodyBuffer(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    const onData = (c: Buffer) => {
      if (rejected) return;
      total += c.length;
      if (total > maxBytes) {
        rejected = true;
        req.removeListener('data', onData);
        req.resume();
        setTimeout(() => req.destroy(), 5_000);
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!rejected) reject(err); });
  });
}

// ─── CORS / rate-limit / validation helpers ───────────────────────────

type CorsAllowlist = '*' | string[];

function buildCorsAllowlist(config: DkgConfig, boundPort: number): CorsAllowlist {
  const raw = config.corsOrigins;
  if (raw === '*') return '*';
  if (typeof raw === 'string' && raw.trim().length > 0) return [raw.trim()];
  if (Array.isArray(raw)) {
    const origins = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (origins.length > 0) return origins;
  }
  // Default: derive from apiHost
  const host = config.apiHost ?? '127.0.0.1';
  if (host === '0.0.0.0') return '*'; // backward-compatible
  return [
    `http://127.0.0.1:${boundPort}`,
    `http://localhost:${boundPort}`,
    `http://[::1]:${boundPort}`,
  ];
}

function resolveCorsOrigin(req: IncomingMessage, allowlist: CorsAllowlist): string | undefined {
  if (allowlist === '*') return '*';
  const origin = req.headers.origin;
  if (!origin) return undefined;
  return allowlist.includes(origin) ? origin : undefined;
}

function corsHeaders(origin?: string | null): Record<string, string> {
  if (!origin) return {};
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (origin !== '*') headers['Vary'] = 'Origin';
  return headers;
}

class HttpRateLimiter {
  private _max: number;
  private _exempt: Set<string>;
  private _hits = new Map<string, { count: number; resetAt: number }>();
  private _timer: ReturnType<typeof setInterval>;

  constructor(requestsPerMinute: number, exemptPaths: string[] = []) {
    this._max = requestsPerMinute;
    this._exempt = new Set(exemptPaths);
    // Sweep expired buckets every 60s
    this._timer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this._hits) {
        if (now >= bucket.resetAt) this._hits.delete(key);
      }
    }, 60_000);
    if (this._timer.unref) this._timer.unref();
  }

  isAllowed(ip: string, pathname: string): boolean {
    if (this._exempt.has(pathname)) return true;
    const now = Date.now();
    let bucket = this._hits.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 60_000 };
      this._hits.set(ip, bucket);
    }
    bucket.count += 1;
    return bucket.count <= this._max;
  }

  destroy(): void {
    clearInterval(this._timer);
    this._hits.clear();
  }
}

function isValidContextGraphId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  if (id.length > 256) return false;
  // Allow URNs, DIDs, simple slug-like identifiers, and URIs
  return /^[\w:/.@\-]+$/.test(id);
}

function shortId(peerId: string): string {
  if (peerId.length > 16) return peerId.slice(0, 8) + '...' + peerId.slice(-4);
  return peerId;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function deriveBlockExplorerUrl(chainId?: string): string | undefined {
  if (!chainId) return undefined;
  const id = chainId.includes(':') ? chainId.split(':')[1] : chainId;
  switch (id) {
    case '84532': return 'https://sepolia.basescan.org';
    case '8453': return 'https://basescan.org';
    case '1': return 'https://etherscan.io';
    case '11155111': return 'https://sepolia.etherscan.io';
    default: return undefined;
  }
}

/** Normalize repo to "owner/name" (strip URL prefix or .git suffix). */
function normalizeRepo(repo: string): string {
  const t = repo.trim().replace(/\.git$/i, '');
  const m = t.match(/github\.com[/:](\S+\/\S+?)(?:\/|$)/);
  if (m) return m[1];
  return t;
}

function parseTagName(ref: string): string | null {
  const m = ref.match(/^refs\/tags\/(.+)$/);
  return m ? m[1] : null;
}

function isValidRef(ref: string): boolean {
  return /^[\w./+\-]+$/.test(ref) && !ref.startsWith('-');
}

function isValidRepoSpec(repo: string): boolean {
  const trimmed = repo.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('-')) return false;
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return false;
  if (/\s/.test(trimmed)) return false;

  if (trimmed.startsWith('/') || /^[A-Za-z]:\\/.test(trimmed)) return true; // Absolute local path.
  if (trimmed.startsWith('file://')) return true;
  if (trimmed.startsWith('https://') || trimmed.startsWith('ssh://') || trimmed.startsWith('git@')) return true;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(trimmed)) return true; // owner/name or owner/name.git
  if (/^[A-Za-z0-9._/\-]+$/.test(trimmed)) return true; // Relative local path.

  return false;
}

function repoToFetchUrl(repo: string): string {
  const trimmed = repo.trim();
  if (!isValidRepoSpec(trimmed)) {
    throw new Error(`invalid autoUpdate.repo "${repo}"`);
  }
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('/') || trimmed.includes('://') || trimmed.startsWith('git@')) return trimmed;
  const normalized = normalizeRepo(trimmed);
  if (/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    return `https://github.com/${normalized}.git`;
  }
  return trimmed;
}

function githubRepoForApi(repo: string): string | null {
  const trimmed = repo.trim().replace(/\.git$/i, '');
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\/|$)/i);
  if (urlMatch) return urlMatch[1];
  // Treat plain owner/name as GitHub shorthand; explicit paths should use ./ or / prefixes.
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) return trimmed;
  return null;
}

async function resolveRemoteCommitSha(
  repoSpec: string,
  ref: string,
  log: (msg: string) => void,
  gitEnv: NodeJS.ProcessEnv,
): Promise<string | null> {
  let fetchUrl = '';
  try {
    fetchUrl = repoToFetchUrl(repoSpec);
  } catch (err: any) {
    log(`Auto-update: ${err?.message ?? 'invalid autoUpdate.repo'}`);
    return null;
  }
  const githubRepo = githubRepoForApi(repoSpec);
  const isSshRepo = fetchUrl.startsWith('git@') || fetchUrl.startsWith('ssh://');
  const apiRef = ref.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '');

  // Fast path for GitHub repos to preserve token-authenticated checks.
  if (githubRepo && !isSshRepo) {
    const url = `https://api.github.com/repos/${githubRepo}/commits/${encodeURIComponent(apiRef)}`;
    const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
    const token = process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      if (res.status === 422 && ref.startsWith('refs/tags/')) {
        log(`Auto-update: tag "${apiRef}" not found in ${githubRepo}`);
        return null;
      }
      if (res.status === 404) {
        log(
          `Auto-update: GitHub returned 404 for ${githubRepo} ref "${ref}". ` +
            'If the repo is private, set GITHUB_TOKEN. Otherwise check repo/ref in config.',
        );
      } else {
        log(`Auto-update: GitHub API returned ${res.status} for ${url}`);
      }
      return null;
    }
    const data = await res.json() as { sha?: string };
    return data.sha ? String(data.sha).trim() : null;
  }

  // Generic path for local/non-GitHub repositories.
  const queryRefs = ref.startsWith('refs/tags/')
    ? [ref, `${ref}^{}`]
    : [ref];
  try {
    const raw = await execFileAsync('git', [...gitCommandArgs(fetchUrl, null), 'ls-remote', fetchUrl, ...queryRefs], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: gitEnv,
    });
    const stdout = typeof raw === 'string' ? raw : String((raw as any)?.stdout ?? '');
    const lines = String(stdout).trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      log(`Auto-update: ref "${ref}" not found in ${fetchUrl}`);
      return null;
    }
    const peeledTagRef = `${ref}^{}`;
    const parsed = lines
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts.length >= 2)
      .map(([sha, remoteRef]) => ({ sha: sha.trim(), remoteRef: remoteRef.trim() }))
      .filter((entry) => /^[0-9a-f]{7,40}$/i.test(entry.sha));
    const peeled = parsed.find((entry) => entry.remoteRef === peeledTagRef);
    if (peeled) return peeled.sha;
    const exact = parsed.find((entry) => entry.remoteRef === ref);
    if (exact) return exact.sha;
    return parsed[0]?.sha ?? null;
  } catch (err: any) {
    log(`Auto-update: failed to resolve remote ref ${ref} from ${fetchUrl} (${err?.message ?? String(err)})`);
    return null;
  }
}

type PendingUpdateState = {
  target: 'a' | 'b';
  commit: string;
  version?: string;
  ref: string;
  createdAt: string;
};

export type CommitCheckStatus = {
  status: 'available' | 'up-to-date' | 'error';
  commit?: string;
};

async function readPendingUpdateState(): Promise<PendingUpdateState | null> {
  const pendingFile = join(dkgDir(), '.update-pending.json');
  try {
    const raw = await readFile(pendingFile, 'utf-8');
    const parsed = JSON.parse(raw) as PendingUpdateState;
    if ((parsed.target !== 'a' && parsed.target !== 'b') || !parsed.ref) return null;
    if (!parsed.commit && !parsed.version) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function clearPendingUpdateState(): Promise<void> {
  const pendingFile = join(dkgDir(), '.update-pending.json');
  try { await unlink(pendingFile); } catch { /* ok */ }
}

async function writePendingUpdateState(state: PendingUpdateState): Promise<void> {
  const pendingFile = join(dkgDir(), '.update-pending.json');
  await writeFile(pendingFile, JSON.stringify(state, null, 2));
}

// ─── NPM-based auto-update helpers ──────────────────────────────────

/**
 * Query the NPM registry for the latest published version of the CLI package.
 * Uses `dist-tags.latest` by default; when `allowPrerelease` is true, also
 * checks `beta` / `next` tags and picks the highest semver.
 */
type NpmVersionResult = { version: string; error?: false } | { version: null; error: true } | { version: null; error: false };

async function resolveLatestNpmVersion(
  log: (msg: string) => void,
  allowPrerelease = true,
): Promise<NpmVersionResult> {
  const url = `https://registry.npmjs.org/${CLI_NPM_PACKAGE}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log(`Auto-update (npm): registry returned ${res.status} for ${CLI_NPM_PACKAGE}`);
      return { version: null, error: true };
    }
    const data = await res.json() as { 'dist-tags'?: Record<string, string> };
    const tags = data['dist-tags'];
    if (!tags) return { version: null, error: true };

    const stable = tags.latest ?? null;
    if (!allowPrerelease) {
      if (stable && !stable.includes('-')) return { version: stable };
      log('Auto-update (npm): latest dist-tag is a pre-release and allowPrerelease=false, skipping');
      return { version: null, error: false };
    }

    const candidates = [stable, tags.dev, tags.beta, tags.next].filter(Boolean) as string[];
    if (candidates.length === 0) return { version: null, error: false };
    candidates.sort((a, b) => compareSemver(b, a));
    return { version: candidates[0] };
  } catch (err: any) {
    log(`Auto-update (npm): registry check failed (${err?.message ?? String(err)})`);
    return { version: null, error: true };
  }
}

export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
  const pb = b.replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  const stripBuild = (s: string) => s.replace(/\+.*$/, '');
  const preA = a.includes('-') ? stripBuild(a.split('-').slice(1).join('-')) : '';
  const preB = b.includes('-') ? stripBuild(b.split('-').slice(1).join('-')) : '';
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  return preA.localeCompare(preB, undefined, { numeric: true });
}

function getCurrentCliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    return String(pkg.version ?? '').trim();
  } catch { return ''; }
}

export type NpmVersionStatus = {
  status: 'available' | 'up-to-date' | 'error';
  version?: string;
};

export async function checkForNpmVersionUpdate(
  log: (msg: string) => void,
  allowPrerelease = true,
): Promise<NpmVersionStatus> {
  const versionFile = join(dkgDir(), '.current-version');
  let currentVersion = '';
  try {
    currentVersion = (await readFile(versionFile, 'utf-8')).trim();
  } catch {
    currentVersion = getCurrentCliVersion();
  }

  if (!currentVersion) {
    log('Auto-update (npm): unable to determine current version');
    return { status: 'error' };
  }

  const result = await resolveLatestNpmVersion(log, allowPrerelease);
  if (result.version === null) return { status: result.error ? 'error' : 'up-to-date' };

  if (result.version === currentVersion) return { status: 'up-to-date' };
  if (compareSemver(result.version, currentVersion) <= 0) return { status: 'up-to-date' };

  return { status: 'available', version: result.version };
}

/**
 * Install a specific version of the CLI package into a blue-green slot via npm.
 * The slot contains a minimal package.json; `npm install` fetches the
 * pre-built package and all its dependencies.
 */
async function _performNpmUpdateInner(
  targetVersion: string,
  log: (msg: string) => void,
): Promise<UpdateStatus> {
  const rDir = releasesDir();
  await mkdir(rDir, { recursive: true });

  const versionFile = join(dkgDir(), '.current-version');
  const pending = await readPendingUpdateState();
  if (pending) {
    const active = await activeSlot();
    if (active === pending.target && pending.version === targetVersion) {
      await writeFile(versionFile, pending.version);
      await clearPendingUpdateState();
      log(`Auto-update (npm): recovered pending update state for slot ${pending.target} (v${pending.version}).`);
      return 'updated';
    }
    await clearPendingUpdateState();
    if (active === pending.target && pending.version !== targetVersion) {
      log(`Auto-update (npm): pending version ${pending.version} differs from target ${targetVersion}, proceeding with fresh install.`);
    } else {
      log('Auto-update (npm): cleared stale pending update state.');
    }
  }

  const active = await activeSlot();
  const target = active === 'a' ? 'b' : (active === 'b' ? 'a' : 'a');
  const targetDir = join(rDir, target);

  log(`Auto-update (npm): installing ${CLI_NPM_PACKAGE}@${targetVersion} into slot ${target}...`);

  try {
    // Clean the target slot to prevent stale artifacts (e.g. old git builds)
    // from being mistaken for a valid entry point after install.
    const { rm } = await import('node:fs/promises');
    await rm(targetDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    await mkdir(targetDir, { recursive: true });

    const slotPkg = {
      name: 'dkg-release-slot',
      private: true,
      dependencies: { [CLI_NPM_PACKAGE]: targetVersion },
    };
    await writeFile(join(targetDir, 'package.json'), JSON.stringify(slotPkg, null, 2));

    const installStart = Date.now();
    await execAsync(`npm install --production --no-audit --no-fund`, {
      cwd: targetDir,
      encoding: 'utf-8',
      timeout: 180_000,
    });
    const installMs = Date.now() - installStart;
    log(`Auto-update (npm): npm install completed in ${installMs}ms.`);
  } catch (installErr: any) {
    log(`Auto-update (npm): npm install failed — ${installErr?.message ?? String(installErr)}`);
    return 'failed';
  }

  const npmPkgDir = join(targetDir, 'node_modules', '@origintrail-official', 'dkg');
  const npmEntry = join(npmPkgDir, 'dist', 'cli.js');
  if (!existsSync(npmEntry)) {
    log(`Auto-update (npm): entry point missing after install. Aborting swap.`);
    return 'failed';
  }

  let resolvedVersion = targetVersion;
  try {
    const installedPkg = JSON.parse(await readFile(join(npmPkgDir, 'package.json'), 'utf-8'));
    if (installedPkg.version && typeof installedPkg.version === 'string') {
      resolvedVersion = installedPkg.version;
    }
  } catch {
    log(`Auto-update (npm): could not read installed package version, using spec "${targetVersion}"`);
  }

  await writePendingUpdateState({
    target: target as 'a' | 'b',
    commit: '',
    version: resolvedVersion,
    ref: `npm:${resolvedVersion}`,
    createdAt: new Date().toISOString(),
  });

  try {
    log(`Auto-update (npm): swapping active slot to ${target}...`);
    await swapSlot(target as 'a' | 'b');
    await writeFile(versionFile, resolvedVersion);
    await clearPendingUpdateState();
    log(`Auto-update (npm): slot ${target} active (${CLI_NPM_PACKAGE}@${resolvedVersion}).`);
  } catch (swapErr: any) {
    await clearPendingUpdateState();
    log(`Auto-update (npm): symlink swap failed — ${swapErr.message}`);
    return 'failed';
  }

  return 'updated';
}

// ─── Git-based auto-update helpers ──────────────────────────────────

/**
 * Check GitHub for a new commit on the configured branch.
 * Returns the latest commit SHA if an update is available, null otherwise.
 */
export async function checkForNewCommit(
  au: AutoUpdateConfig,
  log: (msg: string) => void,
  refOverride?: string,
): Promise<string | null> {
  const result = await checkForNewCommitWithStatus(au, log, refOverride);
  return result.status === 'available' ? (result.commit ?? null) : null;
}

export async function checkForNewCommitWithStatus(
  au: AutoUpdateConfig,
  log: (msg: string) => void,
  refOverride?: string,
): Promise<CommitCheckStatus> {
  const commitFile = join(dkgDir(), '.current-commit');
  let currentCommit = '';
  try {
    currentCommit = (await readFile(commitFile, 'utf-8')).trim();
  } catch {
    const active = await activeSlot();
    const activeDir = join(releasesDir(), active ?? 'a');
    try {
      currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: activeDir, stdio: 'pipe' }).trim();
    } catch {
      currentCommit = '';
    }
  }

  const ref = (refOverride ?? au.branch).trim() || 'main';
  const gitEnv = gitCommandEnv(au);
  if (!isValidRef(ref)) {
    log(`Auto-update: invalid branch/ref "${ref}"`);
    return { status: 'error' };
  }

  try {
    const latestCommit = await resolveRemoteCommitSha(au.repo, ref, log, gitEnv);
    if (!latestCommit) {
      return { status: 'error' };
    }
    if (latestCommit === currentCommit) return { status: 'up-to-date' };
    return { status: 'available', commit: latestCommit };
  } catch (err: any) {
    log(`Auto-update: failed to check for new commit (${err?.message ?? String(err)})`);
    return { status: 'error' };
  }
}

let _updateInProgress = false;
let _lockToken: string | null = null;
export type UpdateStatus = 'updated' | 'up-to-date' | 'failed';

async function acquireUpdateLock(log: (msg: string) => void): Promise<boolean> {
  const lockPath = join(releasesDir(), '.update.lock');
  try {
    await mkdir(releasesDir(), { recursive: true });
    const { openSync, closeSync, writeFileSync } = await import('node:fs');
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, token);
    closeSync(fd);
    _lockToken = token;
    return true;
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      try {
        const { readFileSync, unlinkSync } = await import('node:fs');
        const raw = String(readFileSync(lockPath, 'utf-8')).trim();
        const parts = raw.split(':');
        const pidStr = parts[0] ?? raw;
        const lockPid = parseInt(pidStr, 10);
        const lockTime = parseInt(parts[1] ?? '0', 10);
        const STALE_MS = 15 * 60 * 1000; // 15 minutes
        if (lockTime && Date.now() - lockTime > STALE_MS) {
          try { unlinkSync(lockPath); } catch {}
          return acquireUpdateLock(log);
        }
        if (lockPid === process.pid) {
          _lockToken = raw;
          return true;
        }
        if (lockPid) {
          try {
            process.kill(lockPid, 0);
            log('Auto-update: another update process holds the lock, skipping');
            return false;
          } catch {
            // Lock holder is dead, remove stale lock
            try { unlinkSync(lockPath); } catch {}
            return acquireUpdateLock(log);
          }
        }
      } catch { /* can't read lock */ }
    }
    // Fail closed: do not proceed if lock semantics are uncertain.
    log(`Auto-update: could not acquire lock (${err.code ?? err.message}), skipping`);
    return false;
  }
}

async function releaseUpdateLock(): Promise<void> {
  const lockPath = join(releasesDir(), '.update.lock');
  try {
    if (!_lockToken) return;
    const { readFileSync, unlinkSync } = await import('node:fs');
    const raw = String(readFileSync(lockPath, 'utf-8')).trim();
    if (raw !== _lockToken) return;
    unlinkSync(lockPath);
  } catch { /* ok */ }
  _lockToken = null;
}

/**
 * Core blue-green update logic. Builds the new version in the inactive slot,
 * then atomically swaps the `releases/current` symlink.
 * Returns true if an update was applied (caller should SIGTERM to restart).
 */
export async function performUpdate(
  au: AutoUpdateConfig,
  log: (msg: string) => void,
  opts: { refOverride?: string; allowPrerelease?: boolean; verifyTagSignature?: boolean } = {},
): Promise<boolean> {
  const status = await performUpdateWithStatus(au, log, opts);
  return status === 'updated';
}

export async function performUpdateWithStatus(
  au: AutoUpdateConfig,
  log: (msg: string) => void,
  opts: { refOverride?: string; allowPrerelease?: boolean; verifyTagSignature?: boolean } = {},
): Promise<UpdateStatus> {
  if (_updateInProgress) {
    log('Auto-update: another update is already in progress, skipping');
    return 'failed';
  }
  _updateInProgress = true;
  const locked = await acquireUpdateLock(log);
  if (!locked) {
    _updateInProgress = false;
    return 'failed';
  }
  try {
    return await _performUpdateInner(au, log, opts);
  } finally {
    await releaseUpdateLock();
    _updateInProgress = false;
  }
}

async function _performUpdateInner(
  au: AutoUpdateConfig,
  log: (msg: string) => void,
  opts: { refOverride?: string; allowPrerelease?: boolean; verifyTagSignature?: boolean },
): Promise<UpdateStatus> {
  const rDir = releasesDir();
  const activeDir = join(rDir, (await activeSlot()) ?? 'a');
  const target = await inactiveSlot();
  const targetDir = join(rDir, target);

  // Bail out if the active slot is missing; target slot can self-heal below.
  if (!existsSync(activeDir)) {
    log('Auto-update: skipping — blue-green slots not initialized (run "dkg start" first)');
    return 'failed';
  }

  const commitFile = join(dkgDir(), '.current-commit');
  const versionFile = join(dkgDir(), '.current-version');

  let currentCommit = '';
  try {
    currentCommit = (await readFile(commitFile, 'utf-8')).trim();
  } catch {
    try {
      const { stdout } = await execAsync('git rev-parse HEAD', { encoding: 'utf-8', cwd: activeDir });
      currentCommit = stdout.trim();
      await writeFile(commitFile, currentCommit);
    } catch {
      return 'failed';
    }
  }

  const pending = await readPendingUpdateState();
  if (pending) {
    const active = await activeSlot();
    if (active === pending.target) {
      if (pending.commit) await writeFile(commitFile, pending.commit);
      if (pending.version) await writeFile(versionFile, pending.version);
      await clearPendingUpdateState();
      currentCommit = pending.commit || currentCommit;
      log(`Auto-update: recovered pending update state for slot ${pending.target}.`);
    } else {
      await clearPendingUpdateState();
      log('Auto-update: cleared stale pending update state.');
    }
  }

  const ref = (opts.refOverride ?? au.branch).trim() || 'main';
  const gitEnv = gitCommandEnv(au);

  if (!isValidRef(ref)) {
    log(`Auto-update: invalid branch/ref "${ref}"`);
    return 'failed';
  }
  const latestCommit = await resolveRemoteCommitSha(au.repo, ref, log, gitEnv);
  if (!latestCommit) return 'failed';

  if (latestCommit === currentCommit) return 'up-to-date';

  log(`Auto-update: new commit detected (${latestCommit.slice(0, 8)}) for "${ref}", building in slot ${target}...`);
  let checkedOutCommit = latestCommit;
  let fetchUrl = '';

  try {
    fetchUrl = repoToFetchUrl(au.repo);
  } catch (repoErr: any) {
    log(`Auto-update: ${repoErr?.message ?? 'invalid autoUpdate.repo'}`);
    return 'failed';
  }

  if (!existsSync(join(targetDir, '.git'))) {
    try {
      log(`Auto-update: slot ${target} missing git metadata; reinitializing slot repo.`);
      await mkdir(targetDir, { recursive: true });
      await execFileAsync('git', ['init'], {
        cwd: targetDir,
        encoding: 'utf-8',
        timeout: 30_000,
      });
    } catch (initErr: any) {
      log(`Auto-update: failed to initialize slot ${target} repo — ${initErr?.message ?? String(initErr)}`);
      return 'failed';
    }
  }

  try {
    const maybeTag = parseTagName(ref);
    const fetchRef = maybeTag
      ? `${ref}:${ref}`
      : ref;
    const fetchStartedAt = Date.now();
    log(`Auto-update: fetching "${ref}" from ${fetchUrl} into slot ${target}...`);
    await execFileAsync('git', [...gitCommandArgs(fetchUrl, au), 'fetch', fetchUrl, fetchRef], {
      cwd: targetDir,
      encoding: 'utf-8',
      timeout: 120_000,
      env: gitEnv,
    });
    if (opts.verifyTagSignature && maybeTag) {
      await execFileAsync('git', ['verify-tag', maybeTag], {
        cwd: targetDir,
        encoding: 'utf-8',
        timeout: 30_000,
      });
    }
    await execFileAsync('git', ['checkout', '--force', 'FETCH_HEAD'], {
      cwd: targetDir,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    log(`Auto-update: cleaning slot ${target} working tree (git clean -fdx)...`);
    await execFileAsync('git', ['clean', '-fdx'], {
      cwd: targetDir,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: targetDir,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    const resolved = String(stdout).trim();
    if (/^[0-9a-f]{7,40}$/i.test(resolved)) checkedOutCommit = resolved;
    const fetchElapsedMs = Date.now() - fetchStartedAt;
    log(
      `Auto-update: fetch complete in slot ${target}, checked out ${checkedOutCommit.slice(0, 8)} ` +
      `(in ${fetchElapsedMs}ms).`,
    );
  } catch (fetchErr: any) {
    log(`Auto-update: git fetch/checkout/verify failed in slot ${target} — ${fetchErr.message}`);
    return 'failed';
  }

  try {
    await execAsync('pnpm install --frozen-lockfile', {
      cwd: targetDir, encoding: 'utf-8', timeout: 180_000,
    });
    let usedFullBuildFallback = false;
    let hasRuntimeBuildScript = false;
    try {
      const rootPkgRaw = await readFile(join(targetDir, 'package.json'), 'utf-8');
      const rootPkg = JSON.parse(rootPkgRaw) as { scripts?: Record<string, string> };
      hasRuntimeBuildScript = typeof rootPkg.scripts?.['build:runtime'] === 'string';
    } catch {
      hasRuntimeBuildScript = false;
    }

    if (hasRuntimeBuildScript) {
      await execAsync('pnpm build:runtime', {
        cwd: targetDir, encoding: 'utf-8', timeout: 180_000,
      });
    } else {
      log('Auto-update: target repo has no build:runtime script; falling back to pnpm build.');
      await execAsync('pnpm build', {
        cwd: targetDir, encoding: 'utf-8', timeout: 180_000,
      });
      usedFullBuildFallback = true;
    }

    if (usedFullBuildFallback) {
      log('Auto-update: contract build check skipped (full build fallback already executed).');
    } else {
      let shouldBuildContracts = false;
      try {
        if (/^[0-9a-f]{6,40}$/i.test(currentCommit) && /^[0-9a-f]{6,40}$/i.test(checkedOutCommit)) {
          const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${currentCommit}..${checkedOutCommit}`], {
            cwd: targetDir,
            encoding: 'utf-8',
            timeout: 30_000,
          });
          const changedPaths = String(stdout)
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
          shouldBuildContracts = changedPaths.some((p) => p.startsWith('packages/evm-module/contracts/'));
        }
      } catch (diffErr: any) {
        log(`Auto-update: contract-change check failed (${diffErr.message}); skipping contract build.`);
        shouldBuildContracts = false;
      }

      if (shouldBuildContracts) {
        log('Auto-update: contract folder changes detected; building @origintrail-official/dkg-evm-module...');
        await execAsync('pnpm --filter @origintrail-official/dkg-evm-module build', {
          cwd: targetDir,
          encoding: 'utf-8',
          timeout: 300_000,
        });
        log('Auto-update: @origintrail-official/dkg-evm-module build completed.');
      } else {
        log('Auto-update: no contract folder changes detected; skipping @origintrail-official/dkg-evm-module build.');
      }
    }
  } catch (err: any) {
    log(`Auto-update: build failed in slot ${target} — ${err.message}. Active slot untouched.`);
    return 'failed';
  }

  const entryFile = join(targetDir, 'packages', 'cli', 'dist', 'cli.js');
  if (!existsSync(entryFile)) {
    log(`Auto-update: build output missing (${entryFile}). Aborting swap.`);
    return 'failed';
  }

  let nextVersion = '';
  try {
    const pkgRaw = await readFile(join(targetDir, 'packages', 'cli', 'package.json'), 'utf-8');
    nextVersion = String((JSON.parse(pkgRaw) as { version?: string }).version ?? '').trim();
  } catch {
    // Version is optional metadata for operators; commit SHA remains source of truth.
  }
  const allowPrerelease = opts.allowPrerelease ?? au.allowPrerelease ?? true;
  if (nextVersion && !allowPrerelease && /^[0-9]+\.[0-9]+\.[0-9]+-/.test(nextVersion)) {
    log(`Auto-update: target version ${nextVersion} is pre-release and allowPrerelease=false. Aborting swap.`);
    return 'failed';
  }

  await writePendingUpdateState({
    target,
    commit: checkedOutCommit,
    version: nextVersion || undefined,
    ref,
    createdAt: new Date().toISOString(),
  });
  try {
    const swapStartedAt = Date.now();
    log(`Auto-update: swapping active slot to ${target}...`);
    await swapSlot(target);
    await writeFile(commitFile, checkedOutCommit);
    if (nextVersion) await writeFile(versionFile, nextVersion);
    await clearPendingUpdateState();
    const swapElapsedMs = Date.now() - swapStartedAt;
    log(`Auto-update: swap complete; active slot is now ${target} (${checkedOutCommit.slice(0, 8)}) in ${swapElapsedMs}ms.`);
  } catch (swapErr: any) {
    await clearPendingUpdateState();
    log(`Auto-update: symlink swap failed — ${swapErr.message}`);
    return 'failed';
  }
  log(
    `Auto-update: build succeeded in slot ${target}` +
      `${nextVersion ? ` (version ${nextVersion})` : ''}. Swapped symlink. Restarting...`,
  );
  log('v9 auto-update test live leeroy jenkins');
  return 'updated';
}

export async function performNpmUpdate(
  targetVersion: string,
  log: (msg: string) => void,
): Promise<UpdateStatus> {
  if (_updateInProgress) {
    log('Auto-update (npm): another update is already in progress, skipping');
    return 'failed';
  }
  _updateInProgress = true;
  const locked = await acquireUpdateLock(log);
  if (!locked) {
    _updateInProgress = false;
    return 'failed';
  }
  try {
    return await _performNpmUpdateInner(targetVersion, log);
  } finally {
    await releaseUpdateLock();
    _updateInProgress = false;
  }
}

export async function checkForUpdate(
  au: AutoUpdateConfig,
  log: (msg: string) => void,
): Promise<boolean> {
  try {
    const updated = await performUpdate(au, log);
    return updated;
  } catch (err: any) {
    log(`Auto-update: error — ${err.message}`);
    return false;
  }
}
