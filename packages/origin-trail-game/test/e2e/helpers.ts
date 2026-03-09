/**
 * E2E test helpers: spin up N DKG nodes with OriginTrail Game loaded.
 *
 * Uses the devnet.sh infrastructure from dkg-v9 to start a local Hardhat
 * chain and deploy contracts, then starts N daemon processes.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve to monorepo root: test/e2e -> origin-trail-game -> packages -> dkg-v9
const DKG_V9_ROOT = join(__dirname, '..', '..', '..', '..');
const CLI_JS = join(DKG_V9_ROOT, 'packages', 'cli', 'dist', 'cli.js');
const TEST_DIR = join(__dirname, '..', '..', '.test-nodes');

const API_PORT_BASE = 19200;
const LIBP2P_PORT_BASE = 19300;

export interface TestNode {
  index: number;
  apiPort: number;
  libp2pPort: number;
  homeDir: string;
  process: ChildProcess;
  authToken: string;
}

async function httpGet(url: string, token?: string): Promise<any> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  return res.json();
}

async function httpPost(url: string, body: any, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  return res.json();
}

async function waitForReady(port: number, maxWaitMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (res.ok) return;
    } catch { /* not ready */ }
    await sleep(500);
  }
  throw new Error(`Node on port ${port} did not become ready within ${maxWaitMs}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function startTestCluster(nodeCount: number): Promise<TestNode[]> {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });

  const authToken = 'test-token-for-e2e';

  const nodes: TestNode[] = [];

  for (let i = 0; i < nodeCount; i++) {
    const homeDir = join(TEST_DIR, `node${i + 1}`);
    mkdirSync(homeDir, { recursive: true });

    const apiPort = API_PORT_BASE + i;
    const libp2pPort = LIBP2P_PORT_BASE + i;
    const isRelay = i === 0;

    const config: any = {
      name: `test-node-${i + 1}`,
      apiPort,
      listenPort: libp2pPort,
      nodeRole: isRelay ? 'core' : 'edge',
      paranets: ['origin-trail-game'],
      auth: { enabled: true, tokens: [authToken] },
    };

    if (isRelay) {
      config.relay = 'none';
    }

    writeFileSync(join(homeDir, 'config.json'), JSON.stringify(config, null, 2));
    writeFileSync(join(homeDir, 'auth.token'), authToken);

    nodes.push({ index: i, apiPort, libp2pPort, homeDir, process: null as any, authToken });
  }

  // Start node 1 (relay) first
  nodes[0].process = startDaemon(nodes[0]);
  await waitForReady(nodes[0].apiPort);

  // Get node 1's multiaddr for other nodes to use as relay
  const status = await httpGet(`http://127.0.0.1:${nodes[0].apiPort}/api/status`);
  const relayAddr = status.multiaddrs?.find((a: string) => a.includes('127.0.0.1'))
    ?? `/ip4/127.0.0.1/tcp/${nodes[0].libp2pPort}/p2p/${status.peerId}`;

  // Start remaining nodes bootstrapped to node 1
  for (let i = 1; i < nodeCount; i++) {
    const configPath = join(nodes[i].homeDir, 'config.json');
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    cfg.relay = 'none';
    cfg.bootstrapPeers = [relayAddr];
    cfg.enableMdns = true;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    nodes[i].process = startDaemon(nodes[i]);
  }

  // Wait for all nodes to be ready
  await Promise.all(nodes.slice(1).map(n => waitForReady(n.apiPort)));

  // Wait for gossipsub mesh to form
  await sleep(3000);

  return nodes;
}

function startDaemon(node: TestNode): ChildProcess {
  const child = spawn(
    process.execPath,
    [CLI_JS, 'start', '--foreground'],
    {
      env: { ...process.env, DKG_HOME: node.homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const logFile = join(node.homeDir, 'test-daemon.log');
  const logStream = createWriteStream(logFile, { flags: 'a' });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  return child;
}

export async function stopTestCluster(nodes: TestNode[]): Promise<void> {
  for (const node of nodes) {
    if (node.process && !node.process.killed) {
      node.process.kill('SIGTERM');
    }
  }
  await sleep(2000);
  for (const node of nodes) {
    if (node.process && !node.process.killed) {
      node.process.kill('SIGKILL');
    }
  }
}

export function nodeApi(node: TestNode) {
  const base = `http://127.0.0.1:${node.apiPort}`;
  const token = node.authToken;
  const game = `${base}/api/apps/origin-trail-game`;

  return {
    status: () => httpGet(`${base}/api/status`),
    apps: () => httpGet(`${base}/api/apps`, token),
    info: () => httpGet(`${game}/info`, token),
    lobby: () => httpGet(`${game}/lobby`, token),
    swarm: (id: string) => httpGet(`${game}/swarm/${id}`, token),
    leaderboard: () => httpGet(`${game}/leaderboard`, token),
    notifications: () => httpGet(`${game}/notifications`, token),
    players: () => httpGet(`${game}/players`, token),
    create: (playerName: string, swarmName: string, maxPlayers?: number) =>
      httpPost(`${game}/create`, { playerName, swarmName, maxPlayers }, token),
    join: (swarmId: string, playerName: string) =>
      httpPost(`${game}/join`, { swarmId, playerName }, token),
    leave: (swarmId: string) =>
      httpPost(`${game}/leave`, { swarmId }, token),
    start: (swarmId: string) =>
      httpPost(`${game}/start`, { swarmId }, token),
    vote: (swarmId: string, action: string, params?: any) =>
      httpPost(`${game}/vote`, { swarmId, voteAction: action, params }, token),
    forceResolve: (swarmId: string) =>
      httpPost(`${game}/force-resolve`, { swarmId }, token),
    markNotificationsRead: (ids?: string[]) =>
      httpPost(`${game}/notifications/read`, ids ? { ids } : {}, token),
  };
}

export async function httpGetRaw(url: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { headers });
}
