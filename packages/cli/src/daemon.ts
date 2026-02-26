import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { DKGAgent, loadOpWallets } from '@dkg/agent';
import { computeNetworkId } from '@dkg/core';
import {
  loadConfig,
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

interface ChatEntry {
  ts: number;
  direction: 'in' | 'out';
  peer: string;
  peerName?: string;
  text: string;
}

const MAX_MESSAGES = 500;

export async function runDaemon(foreground: boolean): Promise<void> {
  await ensureDkgDir();
  const config = await loadConfig();
  const startedAt = Date.now();
  const messages: ChatEntry[] = [];

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

  const agent = await DKGAgent.create({
    name: config.name,
    framework: 'DKG',
    listenPort: config.listenPort,
    dataDir: dkgDir(),
    relayPeers: config.relay ? [config.relay] : undefined,
    announceAddresses: config.announceAddresses,
    nodeRole: role,
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
    pushMessage(messages, { ts: Date.now(), direction: 'in', peer: senderPeerId, text });
    log(`CHAT IN  [${shortId(senderPeerId)}]: ${text}`);
  });

  await agent.start();
  await agent.publishProfile();

  log(`PeerId: ${agent.peerId}`);
  for (const a of agent.multiaddrs) log(`  ${a}`);

  if (config.relay) {
    log(`Relay: ${config.relay}`);
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

  // Subscribe to configured paranets + network defaults
  const paranetsToSubscribe = new Set([
    ...(config.paranets ?? []),
    ...(network?.defaultParanets ?? []),
  ]);
  for (const p of paranetsToSubscribe) {
    const exists = await agent.paranetExists(p);
    if (!exists) {
      try {
        await agent.createParanet({ id: p, name: p, description: `Default testnet paranet "${p}"` });
        log(`Created paranet: ${p}`);
      } catch {
        log(`Paranet "${p}" not yet available (will receive via gossip)`);
      }
    }
    agent.subscribeToParanet(p);
    log(`Subscribed to paranet: ${p}`);
  }

  // Profile is published once at startup (above). No periodic re-publish —
  // peers discover us via the initial gossip broadcast + relay.

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

  // --- HTTP API ---

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, agent, config, startedAt, messages, opWallets, network);
    } catch (err: any) {
      jsonResponse(res, 500, { error: err.message });
    }
  });

  const apiPort = config.apiPort || 0;
  await new Promise<void>((resolve) => {
    server.listen(apiPort, '127.0.0.1', () => resolve());
  });
  const boundPort = (server.address() as any).port as number;
  await writeApiPort(boundPort);
  await writePid(process.pid);

  log(`API listening on http://127.0.0.1:${boundPort}`);
  log('Node is running. Use "dkg status" or "dkg peers" to interact.');

  // Graceful shutdown
  async function shutdown() {
    log('Shutting down...');
    if (updateInterval) clearInterval(updateInterval);
    server.close();
    await agent.stop();
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
  messages: ChatEntry[],
  opWallets: import('@dkg/agent').OpWalletsConfig,
  network: Awaited<ReturnType<typeof loadNetworkConfig>>,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;

  // GET /api/status
  if (req.method === 'GET' && path === '/api/status') {
    const peers = agent.node.libp2p.getPeers();
    const circuitAddrs = agent.multiaddrs.filter(a => a.includes('/p2p-circuit/'));
    const networkId = await computeNetworkId();
    return jsonResponse(res, 200, {
      name: config.name,
      peerId: agent.peerId,
      nodeRole: config.nodeRole ?? 'edge',
      networkId: networkId.slice(0, 16),
      uptimeMs: Date.now() - startedAt,
      connectedPeers: peers.length,
      relayConnected: circuitAddrs.length > 0,
      multiaddrs: agent.multiaddrs,
    });
  }

  // GET /api/agents
  if (req.method === 'GET' && path === '/api/agents') {
    const agents = await agent.findAgents();
    return jsonResponse(res, 200, { agents });
  }

  // GET /api/skills
  if (req.method === 'GET' && path === '/api/skills') {
    const skills = await agent.findSkills();
    return jsonResponse(res, 200, { skills });
  }

  // POST /api/chat  { to: "name-or-peerId", text: "..." }
  if (req.method === 'POST' && path === '/api/chat') {
    const body = await readBody(req);
    const { to, text } = JSON.parse(body);
    if (!to || !text) return jsonResponse(res, 400, { error: 'Missing "to" or "text"' });

    const peerId = await resolveNameToPeerId(agent, to);
    if (!peerId) return jsonResponse(res, 404, { error: `Agent "${to}" not found` });

    const result = await agent.sendChat(peerId, text);
    if (result.delivered) {
      pushMessage(messages, { ts: Date.now(), direction: 'out', peer: peerId, text });
    }
    return jsonResponse(res, 200, result);
  }

  // GET /api/messages?peer=<name-or-id>&limit=N
  if (req.method === 'GET' && path === '/api/messages') {
    const peerFilter = url.searchParams.get('peer');
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
    const since = parseInt(url.searchParams.get('since') ?? '0', 10);

    let filtered = messages;
    if (since > 0) {
      filtered = filtered.filter(m => m.ts > since);
    }
    if (peerFilter) {
      const peerId = await resolveNameToPeerId(agent, peerFilter);
      if (peerId) {
        filtered = filtered.filter(m => m.peer === peerId);
      }
    }
    return jsonResponse(res, 200, { messages: filtered.slice(-limit) });
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
    const body = await readBody(req);
    const { paranetId, quads, privateQuads } = JSON.parse(body);
    if (!paranetId || !quads?.length) {
      return jsonResponse(res, 400, { error: 'Missing "paranetId" or "quads"' });
    }
    const result = await agent.publish(paranetId, quads, privateQuads);
    const chain = result.onChainResult;
    return jsonResponse(res, 200, {
      kcId: String(result.kcId),
      status: result.status,
      kas: result.kaManifest.map(ka => ({
        tokenId: String(ka.tokenId),
        rootEntity: ka.rootEntity,
      })),
      ...(chain && {
        txHash: chain.txHash,
        blockNumber: chain.blockNumber,
        batchId: String(chain.batchId),
        publisherAddress: chain.publisherAddress,
      }),
    });
  }

  // POST /api/query  { sparql: "...", paranetId?: "..." }
  if (req.method === 'POST' && path === '/api/query') {
    const body = await readBody(req);
    const { sparql, paranetId } = JSON.parse(body);
    if (!sparql) return jsonResponse(res, 400, { error: 'Missing "sparql"' });
    const result = await agent.query(sparql, paranetId);
    return jsonResponse(res, 200, { result });
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

  // GET /api/paranet/exists?id=<paranetId>
  if (req.method === 'GET' && path === '/api/paranet/exists') {
    const id = url.searchParams.get('id');
    if (!id) return jsonResponse(res, 400, { error: 'Missing "id" query param' });
    const exists = await agent.paranetExists(id);
    return jsonResponse(res, 200, { id, exists });
  }

  // GET /api/wallets
  if (req.method === 'GET' && (path === '/api/wallet' || path === '/api/wallets')) {
    return jsonResponse(res, 200, {
      wallets: opWallets.wallets.map((w) => w.address),
      chainId: (config.chain ?? network?.chain)?.chainId,
    });
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

function pushMessage(messages: ChatEntry[], entry: ChatEntry): void {
  messages.push(entry);
  if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
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

/** Normalize repo to "owner/name" (strip URL prefix or .git suffix). */
function normalizeRepo(repo: string): string {
  const t = repo.trim().replace(/\.git$/i, '');
  const m = t.match(/github\.com[/:](\S+\/\S+?)(?:\/|$)/);
  if (m) return m[1];
  return t;
}

async function checkForUpdate(
  au: AutoUpdateConfig,
  log: (msg: string) => void,
): Promise<void> {
  try {
    const commitFile = join(dkgDir(), '.current-commit');

    // Get current running commit
    let currentCommit = '';
    try {
      currentCommit = (await readFile(commitFile, 'utf-8')).trim();
    } catch {
      // First run — record current commit
      try {
        currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: process.cwd() }).trim();
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

    // Pull and rebuild
    const cwd = process.cwd();
    try {
      execSync(`git fetch origin ${branch} && git reset --hard origin/${branch}`, {
        cwd, encoding: 'utf-8', stdio: 'pipe',
      });
      execSync('pnpm install --frozen-lockfile', {
        cwd, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000,
      });
      execSync('pnpm build', {
        cwd, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000,
      });
    } catch (err: any) {
      log(`Auto-update: build failed, rolling back to ${currentCommit.slice(0, 8)}`);
      try {
        execSync(`git reset --hard ${currentCommit}`, { cwd, encoding: 'utf-8', stdio: 'pipe' });
        execSync('pnpm install --frozen-lockfile', { cwd, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
        execSync('pnpm build', { cwd, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
      } catch {
        log('Auto-update: rollback also failed — manual intervention needed');
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
