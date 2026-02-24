import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFile } from 'node:fs/promises';
import { DKGAgent } from '@dkg/agent';
import { computeNetworkId } from '@dkg/core';
import {
  loadConfig,
  dkgDir,
  writePid,
  removePid,
  writeApiPort,
  removeApiPort,
  logPath,
  ensureDkgDir,
  type DkgConfig,
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

  function log(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    if (foreground) process.stdout.write(line + '\n');
    appendFile(logPath(), line + '\n').catch(() => {});
  }

  const role = config.nodeRole ?? 'edge';
  log(`Starting DKG ${role} node "${config.name}"...`);

  const agent = await DKGAgent.create({
    name: config.name,
    framework: 'DKG',
    listenPort: config.listenPort,
    dataDir: dkgDir(),
    relayPeers: config.relay ? [config.relay] : undefined,
    nodeRole: role,
  });

  const networkId = await computeNetworkId();
  log(`Network: ${networkId.slice(0, 16)}...`);

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

  // Periodically re-publish profile so new peers discover us
  const profileInterval = setInterval(async () => {
    try { await agent.publishProfile(); } catch {}
  }, 30_000);

  // --- HTTP API ---

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, agent, config, startedAt, messages);
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
    clearInterval(profileInterval);
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
