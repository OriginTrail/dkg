import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { ethers } from 'ethers';
import { DKGAgent, loadOpWallets } from '@dkg/agent';
import { computeNetworkId, createOperationContext, DKGEvent, Logger } from '@dkg/core';
import {
  DashboardDB,
  MetricsCollector,
  OperationTracker,
  handleNodeUIRequest,
  ChatAssistant,
  ChatMemoryManager,
  type MetricsSource,
} from '@dkg/node-ui';
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
  type DkgConfig,
  type AutoUpdateConfig,
} from './config.js';
import { loadTokens, httpAuthGuard, extractBearerToken } from './auth.js';
import { loadApps, handleAppRequest, startAppStaticServer, type LoadedApp } from './app-loader.js';


export async function runDaemon(foreground: boolean): Promise<void> {
  await ensureDkgDir();
  const config = await loadConfig();
  const startedAt = Date.now();

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
    process.exit(1);
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

  const banner = String.raw`
__/\\\\\\\\\\\\_____/\\\________/\\\_____/\\\\\\\\\\\\__/\\\________/\\\______/\\\\\\\\\____        
 _\/\\\////////\\\__\/\\\_____/\\\//____/\\\//////////__\/\\\_______\/\\\____/\\\///////\\\__       
  _\/\\\______\//\\\_\/\\\__/\\\//______/\\\_____________\//\\\______/\\\____/\\\______\//\\\_      
   _\/\\\_______\/\\\_\/\\\\\\//\\\_____\/\\\____/\\\\\\\__\//\\\____/\\\____\//\\\_____/\\\\\_     
    _\/\\\_______\/\\\_\/\\\//_\//\\\____\/\\\___\/////\\\___\//\\\__/\\\______\///\\\\\\\\/\\\_    
     _\/\\\_______\/\\\_\/\\\____\//\\\___\/\\\_______\/\\\____\//\\\/\\\_________\////////\/\\\_   
      _\/\\\_______/\\\__\/\\\_____\//\\\__\/\\\_______\/\\\_____\//\\\\\________/\\________/\\\__  
       _\/\\\\\\\\\\\\/___\/\\\______\//\\\_\//\\\\\\\\\\\\/_______\//\\\________\//\\\\\\\\\\\/___ 
        _\////////////_____\///________\///___\////////////__________\///__________\///////////_____
`;
  origStdoutWrite(banner + '\n');
  appendFile(logFile, banner + '\n').catch(() => {});

  log(`Starting DKG ${role} node "${config.name}"...`);

  const network = await loadNetworkConfig();

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
    syncParanets: config.paranets ?? [],
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
  });

  const networkId = await computeNetworkId();
  log(`Network: ${networkId.slice(0, 16)}...`);
  if (network?.networkId && network.networkId !== networkId) {
    log(`FATAL: genesis mismatch! Expected networkId ${network.networkId.slice(0, 16)}... but computed ${networkId.slice(0, 16)}...`);
    log(`This node's genesis does not match network/testnet.json. Rebuild or update the repo.`);
    process.exit(1);
  }
  if (network) {
    log(`Network config: ${network.networkName} (genesis v${network.genesisVersion})`);
  }

  agent.onChat((text, senderPeerId, _convId) => {
    try { dashDb.insertChatMessage({ ts: Date.now(), direction: 'in', peer: senderPeerId, text }); } catch { /* never crash */ }
    log(`CHAT IN  [${shortId(senderPeerId)}]: ${text}`);
  });

  await agent.start();
  await agent.publishProfile();

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

  // Ensure configured paranets + network defaults are subscribed and available.
  // Uses ensureParanetLocal (idempotent) instead of createParanet to avoid
  // duplicate creator claims and to survive "already exists" gracefully.
  const paranetsToSubscribe = new Set([
    ...(config.paranets ?? []),
    ...(network?.defaultParanets ?? []),
  ]);
  for (const p of paranetsToSubscribe) {
    try {
      await agent.ensureParanetLocal({
        id: p,
        name: p,
        description: `Default paranet: ${p}`,
      });
      log(`Ensured paranet: ${p}`);
    } catch (err) {
      log(`Paranet "${p}" setup failed: ${err instanceof Error ? err.message : String(err)} — will discover via sync/gossip`);
      agent.subscribeToParanet(p);
    }
  }

  // Run an initial chain scan for paranets we might not know about,
  // then repeat every 30 minutes as a fallback discovery mechanism.
  const CHAIN_SCAN_INTERVAL_MS = 30 * 60 * 1000;
  setTimeout(async () => {
    try {
      const found = await agent.discoverParanetsFromChain();
      if (found > 0) log(`Chain scan: discovered ${found} new paranet(s)`);
    } catch { /* non-critical */ }
  }, 15_000);
  const chainScanTimer = setInterval(async () => {
    try {
      const found = await agent.discoverParanetsFromChain();
      if (found > 0) log(`Chain scan: discovered ${found} new paranet(s)`);
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

  // Auto-update
  let updateInterval: ReturnType<typeof setInterval> | null = null;
  if (config.autoUpdate?.enabled) {
    const au = config.autoUpdate;
    log(`Auto-update enabled: ${au.repo}@${au.branch} (every ${au.checkIntervalMinutes}min)`);
    updateInterval = setInterval(
      () => checkForUpdate(au, log),
      au.checkIntervalMinutes * 60_000,
    );
  }

  // --- Dashboard DB + Metrics ---

  const dashDb = new DashboardDB({ dataDir: dkgDir() });
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
    getParanetCount: async () => (await agent.listParanets()).length,
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

  const tracker = new OperationTracker(dashDb);

  // Track peer connections
  agent.eventBus.on(DKGEvent.CONNECTION_OPEN, (data: any) => {
    const ctx = createOperationContext('connect');
    tracker.start(ctx, { peerId: data.peerId });
    tracker.complete(ctx, { details: { transport: data.transport, direction: data.direction } });
  });

  // Track publishes via KC_PUBLISHED event (covers GossipSub-received publishes)
  agent.eventBus.on(DKGEvent.KC_PUBLISHED, (data: any) => {
    const ctx = createOperationContext('publish');
    tracker.start(ctx, { paranetId: data.paranetId, details: { kcId: data.kcId, source: 'gossipsub' } });
    tracker.complete(ctx, { tripleCount: data.tripleCount });
  });

  const agentToolsContext = {
    query: (sparql: string, opts?: { paranetId?: string; graphSuffix?: '_workspace'; includeWorkspace?: boolean }) => agent.query(sparql, opts),
    writeToWorkspace: (paranetId: string, quads: any[], opts?: { localOnly?: boolean }) => agent.writeToWorkspace(paranetId, quads, opts),
    enshrineFromWorkspace: (paranetId: string, selection: 'all' | { rootEntities: string[] }, opts?: { clearWorkspaceAfter?: boolean }) => agent.enshrineFromWorkspace(paranetId, selection, opts),
    createParanet: (opts: { id: string; name: string; description?: string; private?: boolean }) => agent.createParanet(opts),
    listParanets: () => agent.listParanets(),
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

  // Resolve the static UI directory (built by @dkg/node-ui)
  let nodeUiStaticDir: string;
  try {
    const nodeUiPkg = import.meta.resolve('@dkg/node-ui');
    const nodeUiDir = dirname(fileURLToPath(nodeUiPkg));
    nodeUiStaticDir = join(nodeUiDir, '..', 'dist-ui');
  } catch {
    nodeUiStaticDir = join(process.cwd(), 'packages', 'node-ui', 'dist-ui');
  }

  // --- Authentication ---

  const authEnabled = config.auth?.enabled !== false;
  const validTokens = await loadTokens(config.auth);
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
      const result = await startAppStaticServer(installedApps, appHost, desiredAppPort, apiPortRef, log);
      appStaticServer = result.server;
      appStaticPort = result.port;
    } catch (err: any) {
      log(`App static server failed to start: ${err.message}. Apps will be served from main server.`);
    }
  }

  // --- HTTP API ---

  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host}`);

      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
      }

      // Auth guard — rejects with 401 if token is invalid/missing
      if (!httpAuthGuard(req, res, authEnabled, validTokens)) return;

      // Node UI routes (metrics, operations, logs, saved queries, chat, static UI)
      const firstToken = validTokens.size > 0 ? validTokens.values().next().value as string : undefined;
      const handled = await handleNodeUIRequest(req, res, reqUrl, dashDb, nodeUiStaticDir, chatAssistant, metricsCollector, authEnabled ? firstToken : undefined, memoryManager, llmSettings);
      if (handled) return;

      // Installable DKG apps (API handlers + static UI)
      // Always call handleAppRequest so GET /api/apps returns [] when no apps are installed.
      // Inject the caller's verified token if present; when the server is bound to
      // loopback only, fall back to the first stored token for /apps/* requests
      // (TCP guarantees all connections are local — no proxy spoofing possible).
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

      await handleRequest(req, res, agent, config, startedAt, dashDb, opWallets, network, tracker);
    } catch (err: any) {
      jsonResponse(res, 500, { error: err.message });
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
  await writePid(process.pid);

  log(`API listening on http://${apiHost}:${boundPort}`);
  log(`Node UI: http://${apiHost}:${boundPort}/ui`);
  log('Node is running. Use "dkg status" or "dkg peers" to interact.');

  // Graceful shutdown
  async function shutdown() {
    log('Shutting down...');
    if (updateInterval) clearInterval(updateInterval);
    clearInterval(chainScanTimer);
    clearInterval(pingTimer);
    metricsCollector.stop();
    server.close();
    appStaticServer?.close();
    await agent.stop();
    dashDb.close();
    await removePid();
    await removeApiPort();
    log('Stopped.');
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  agent: DKGAgent,
  config: DkgConfig,
  startedAt: number,
  dashDb: DashboardDB,
  opWallets: import('@dkg/agent').OpWalletsConfig,
  network: Awaited<ReturnType<typeof loadNetworkConfig>>,
  tracker: OperationTracker,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;

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
    return jsonResponse(res, 200, {
      name: config.name,
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
  if (req.method === 'GET' && path === '/api/agents') {
    const agents = await agent.findAgents();
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
    const enriched = agents.map((a: any) => {
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
  if (req.method === 'GET' && path === '/api/skills') {
    const skills = await agent.findSkills();
    return jsonResponse(res, 200, { skills });
  }

  // POST /api/chat  { to: "name-or-peerId", text: "..." }
  if (req.method === 'POST' && path === '/api/chat') {
    const serverT0 = Date.now();
    const body = await readBody(req);
    const { to, text } = JSON.parse(body);
    if (!to || !text) return jsonResponse(res, 400, { error: 'Missing "to" or "text"' });

    const resolveT0 = Date.now();
    const peerId = await resolveNameToPeerId(agent, to);
    const resolveDur = Date.now() - resolveT0;
    if (!peerId) return jsonResponse(res, 404, { error: `Agent "${to}" not found` });

    const sendT0 = Date.now();
    const result = await agent.sendChat(peerId, text);
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

  // POST /api/connect  { multiaddr: "..." }
  if (req.method === 'POST' && path === '/api/connect') {
    const body = await readBody(req);
    const { multiaddr: addr } = JSON.parse(body);
    if (!addr) return jsonResponse(res, 400, { error: 'Missing "multiaddr"' });
    await agent.connectTo(addr);
    return jsonResponse(res, 200, { connected: true });
  }

  // POST /api/publish  { paranetId: "...", quads: [...], privateQuads?: [...] }
  if (req.method === 'POST' && path === '/api/publish') {
    const serverT0 = Date.now();
    const body = await readBody(req);
    const { paranetId, quads, privateQuads } = JSON.parse(body);
    if (!paranetId || !quads?.length) {
      return jsonResponse(res, 400, { error: 'Missing "paranetId" or "quads"' });
    }
    const ctx = createOperationContext('publish');
    tracker.start(ctx, { paranetId, details: { tripleCount: quads.length, source: 'api' } });
    const phases: Record<string, number> = {};
    const phaseStarts: Record<string, number> = {};
    try {
      const result = await agent.publish(paranetId, quads, privateQuads, {
        onPhase: (phase, status) => {
          if (status === 'start') {
            tracker.startPhase(ctx, phase);
            phaseStarts[phase] = Date.now();
          } else {
            tracker.completePhase(ctx, phase);
            if (phaseStarts[phase]) phases[phase] = Date.now() - phaseStarts[phase];
          }
        },
      });
      const chain = result.onChainResult;
      if (chain) {
        tracker.setCost(ctx, {
          gasUsed: chain.gasUsed,
          gasPrice: chain.effectiveGasPrice,
          gasCost: chain.gasCostWei,
          tracCost: chain.tokenAmount,
        });
        const chainId = (config.chain ?? network?.chain)?.chainId;
        tracker.setTxHash(ctx, chain.txHash, chainId ? Number(chainId) : undefined);
      }
      tracker.complete(ctx, { tripleCount: quads.length, details: { kcId: String(result.kcId), status: result.status } });
      phases.serverTotal = Date.now() - serverT0;
      return jsonResponse(res, 200, {
        kcId: String(result.kcId),
        status: result.status,
        kas: result.kaManifest.map(ka => ({
          tokenId: String(ka.tokenId),
          rootEntity: ka.rootEntity,
        })),
        phases,
        ...(chain && {
          txHash: chain.txHash,
          blockNumber: chain.blockNumber,
          batchId: String(chain.batchId),
          publisherAddress: chain.publisherAddress,
        }),
      });
    } catch (err) {
      tracker.fail(ctx, err);
      throw err;
    }
  }

  // POST /api/workspace/write  { paranetId: "...", quads: [...] }
  if (req.method === 'POST' && path === '/api/workspace/write') {
    const serverT0 = Date.now();
    const body = await readBody(req);
    const { paranetId, quads } = JSON.parse(body);
    if (!paranetId || !quads?.length) {
      return jsonResponse(res, 400, { error: 'Missing "paranetId" or "quads"' });
    }
    const ctx = createOperationContext('workspace');
    tracker.start(ctx, { paranetId, details: { tripleCount: quads.length, source: 'api' } });
    const storeT0 = Date.now();
    try {
      const result = await agent.writeToWorkspace(paranetId, quads);
      const storeDur = Date.now() - storeT0;
      tracker.complete(ctx, { tripleCount: quads.length, details: { workspaceOperationId: result.workspaceOperationId } });
      return jsonResponse(res, 200, { ...result, phases: { store: storeDur, serverTotal: Date.now() - serverT0 } });
    } catch (err) {
      tracker.fail(ctx, err);
      throw err;
    }
  }

  // POST /api/workspace/enshrine  { paranetId: "...", selection?: "all" | { rootEntities: [...] }, clearAfter?: bool }
  if (req.method === 'POST' && path === '/api/workspace/enshrine') {
    const body = await readBody(req);
    const { paranetId, selection, clearAfter } = JSON.parse(body);
    if (!paranetId) return jsonResponse(res, 400, { error: 'Missing "paranetId"' });
    const ctx = createOperationContext('enshrine');
    tracker.start(ctx, { paranetId, details: { source: 'api' } });
    try {
      const result = await agent.enshrineFromWorkspace(
        paranetId,
        selection || 'all',
        { clearWorkspaceAfter: clearAfter ?? true },
      );
      const chain = result.onChainResult;
      if (chain) {
        tracker.setCost(ctx, { gasUsed: chain.gasUsed, gasPrice: chain.effectiveGasPrice });
      }
      tracker.complete(ctx, { tripleCount: result.kaManifest?.length ?? 0 });
      return jsonResponse(res, 200, {
        kcId: String(result.kcId),
        status: result.status,
        kas: result.kaManifest.map(ka => ({ tokenId: String(ka.tokenId), rootEntity: ka.rootEntity })),
        ...(chain && { txHash: chain.txHash, blockNumber: chain.blockNumber }),
      });
    } catch (err) {
      tracker.fail(ctx, err);
      throw err;
    }
  }

  // POST /api/query  { sparql: "...", paranetId?: "...", graphSuffix?: "_workspace", includeWorkspace?: bool }
  if (req.method === 'POST' && path === '/api/query') {
    const serverT0 = Date.now();
    const body = await readBody(req);
    const { sparql, paranetId, graphSuffix, includeWorkspace } = JSON.parse(body);
    if (!sparql) return jsonResponse(res, 400, { error: 'Missing "sparql"' });
    const ctx = createOperationContext('query');
    tracker.start(ctx, { paranetId, details: { sparql: sparql.slice(0, 200) } });
    tracker.startPhase(ctx, 'parse');
    try {
      tracker.completePhase(ctx, 'parse');
      tracker.startPhase(ctx, 'execute');
      const execT0 = Date.now();
      const result = await agent.query(sparql, { paranetId, graphSuffix, includeWorkspace });
      const execDur = Date.now() - execT0;
      tracker.completePhase(ctx, 'execute');
      tracker.complete(ctx, { tripleCount: result?.bindings?.length ?? 0 });
      return jsonResponse(res, 200, { result, phases: { execute: execDur, serverTotal: Date.now() - serverT0 } });
    } catch (err) {
      tracker.fail(ctx, err);
      throw err;
    }
  }

  // POST /api/query-remote  { peerId, lookupType, paranetId?, ual?, entityUri?, rdfType?, sparql?, limit?, timeout? }
  if (req.method === 'POST' && path === '/api/query-remote') {
    const body = await readBody(req);
    const { peerId: rawPeerId, lookupType, paranetId, ual, entityUri, rdfType, sparql, limit, timeout } = JSON.parse(body);
    if (!rawPeerId) return jsonResponse(res, 400, { error: 'Missing "peerId"' });
    if (!lookupType) return jsonResponse(res, 400, { error: 'Missing "lookupType"' });

    const peerId = await resolveNameToPeerId(agent, rawPeerId);
    if (!peerId) return jsonResponse(res, 404, { error: `Agent "${rawPeerId}" not found` });

    const response = await agent.queryRemote(peerId, {
      lookupType, paranetId, ual, entityUri, rdfType, sparql, limit, timeout,
    });
    return jsonResponse(res, 200, response);
  }

  // POST /api/subscribe  { paranetId: "..." }
  if (req.method === 'POST' && path === '/api/subscribe') {
    const body = await readBody(req);
    const { paranetId } = JSON.parse(body);
    if (!paranetId) return jsonResponse(res, 400, { error: 'Missing "paranetId"' });
    agent.subscribeToParanet(paranetId);
    return jsonResponse(res, 200, { subscribed: paranetId });
  }

  // POST /api/paranet/create  { id, name, description? }
  if (req.method === 'POST' && path === '/api/paranet/create') {
    const body = await readBody(req);
    const { id, name, description } = JSON.parse(body);
    if (!id || !name) return jsonResponse(res, 400, { error: 'Missing "id" or "name"' });
    await agent.createParanet({ id, name, description });
    return jsonResponse(res, 200, { created: id, uri: `did:dkg:paranet:${id}` });
  }

  // GET /api/paranet/list
  if (req.method === 'GET' && path === '/api/paranet/list') {
    const paranets = await agent.listParanets();
    return jsonResponse(res, 200, { paranets });
  }

  // GET /api/integrations — aggregated view for Integrations panel (adapters, skills, paranets)
  if (req.method === 'GET' && path === '/api/integrations') {
    const [skills, paranets] = await Promise.all([agent.findSkills(), agent.listParanets()]);
    const adapters = [
      { id: 'elizaos', name: 'ElizaOS', enabled: true, description: 'Connect to ElizaOS agents' },
      { id: 'openclaw', name: 'OpenClaw', enabled: true, description: 'OpenClaw framework adapter' },
    ];
    return jsonResponse(res, 200, { adapters, skills, paranets });
  }

  // GET /api/paranet/exists?id=<paranetId>
  if (req.method === 'GET' && path === '/api/paranet/exists') {
    const id = url.searchParams.get('id');
    if (!id) return jsonResponse(res, 400, { error: 'Missing "id" query param' });
    const exists = await agent.paranetExists(id);
    return jsonResponse(res, 200, { id, exists });
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

  // POST /api/shutdown
  if (req.method === 'POST' && path === '/api/shutdown') {
    jsonResponse(res, 200, { ok: true });
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);
    return;
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


function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
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

export async function checkForUpdate(
  au: AutoUpdateConfig,
  log: (msg: string) => void,
): Promise<void> {
  try {
    const cwd = process.cwd();

    // Bail out if worktree has uncommitted changes
    const status = execSync('git status --porcelain --untracked-files=no', { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (status) {
      log('Auto-update: skipping — worktree has uncommitted changes');
      return;
    }

    const commitFile = join(dkgDir(), '.current-commit');

    // Get current running commit
    let currentCommit = '';
    try {
      currentCommit = (await readFile(commitFile, 'utf-8')).trim();
    } catch {
      // First run — record current commit
      try {
        currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd }).trim();
        await writeFile(commitFile, currentCommit);
      } catch {
        return;
      }
    }

    const repo = normalizeRepo(au.repo);
    const branch = au.branch.trim() || 'main';
    const url = `https://api.github.com/repos/${repo}/commits/${branch}`;
    const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
    const token = process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (res.status === 404) {
        log(
          `Auto-update: GitHub returned 404 for ${repo} branch "${branch}". ` +
            'If the repo is private, set GITHUB_TOKEN. Otherwise check repo/branch in config.',
        );
      } else {
        log(`Auto-update: GitHub API returned ${res.status} for ${url}`);
      }
      return;
    }
    const data = await res.json() as { sha: string };
    const latestCommit = data.sha;

    if (latestCommit === currentCommit) return;

    log(`Auto-update: new commit detected (${latestCommit.slice(0, 8)}), updating...`);

    try {
      execSync(`git fetch origin ${branch}`, {
        cwd, encoding: 'utf-8', stdio: 'pipe',
      });
    } catch (fetchErr: any) {
      log(`Auto-update: fetch failed — ${fetchErr.message}`);
      return;
    }

    try {
      execSync(`git merge --ff-only origin/${branch}`, {
        cwd, encoding: 'utf-8', stdio: 'pipe',
      });
    } catch {
      log('Auto-update: skipping — fast-forward merge not possible (history has diverged)');
      return;
    }

    try {
      execSync('pnpm install --frozen-lockfile', {
        cwd, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000,
      });
      execSync('pnpm build', {
        cwd, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000,
      });
    } catch (err: any) {
      log(`Auto-update: build failed after merge — ${err.message}`);
      try {
        execSync(`git reset --hard ${currentCommit}`, { cwd, encoding: 'utf-8', stdio: 'pipe' });
        execSync('pnpm install --frozen-lockfile', { cwd, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
        log('Auto-update: rolled back to previous commit after build failure');
        log('Auto-update: warning — node_modules and build artifacts may be stale after rollback');
      } catch (resetErr: any) {
        log(`Auto-update: rollback failed — ${resetErr.message}`);
      }
      return;
    }

    // Record the new commit
    await writeFile(commitFile, latestCommit);
    log(`Auto-update: build succeeded. Restarting daemon...`);

    // Signal the process to restart (pm2 or wrapper script will restart it)
    process.kill(process.pid, 'SIGTERM');
  } catch (err: any) {
    log(`Auto-update: error — ${err.message}`);
  }
}
