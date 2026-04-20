/**
 * E2E test helpers: spin up N DKG nodes with OriginTrail Game loaded.
 *
 * Uses the devnet.sh infrastructure from dkg-v9 to start a local Hardhat
 * chain and deploy contracts, then starts N daemon processes.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve to monorepo root: test/e2e -> origin-trail-game -> packages -> dkg-v9
const DKG_V9_ROOT = join(__dirname, '..', '..', '..', '..');
const CLI_JS = join(DKG_V9_ROOT, 'packages', 'cli', 'dist', 'cli.js');
const EVM_MODULE = join(DKG_V9_ROOT, 'packages', 'evm-module');
const TEST_DIR = join(__dirname, '..', '..', '.test-nodes');

const API_PORT_BASE = 19200;
const LIBP2P_PORT_BASE = 19300;
const HARDHAT_E2E_PORT = 18545;

// Hardhat well-known accounts 5-9 (accounts 0-4 reserved for devnet)
const HARDHAT_WALLETS = [
  { key: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc' },
  { key: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', address: '0x976EA74026E726554dB657fA54763abd0C3a0aa9' },
  { key: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356', address: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955' },
  { key: '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97', address: '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f' },
  { key: '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', address: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720' },
];

export interface TestNode {
  index: number;
  apiPort: number;
  libp2pPort: number;
  homeDir: string;
  process: ChildProcess;
  authToken: string;
}

export interface HardhatChain {
  process: ChildProcess;
  rpcUrl: string;
  hubAddress: string;
  port: number;
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

async function waitForReady(port: number, maxWaitMs = 120_000, homeDir?: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (res.ok) return;
    } catch { /* not ready */ }
    await sleep(500);
  }
  // Include daemon log tail so CI failures are actually diagnosable instead
  // of just "did not become ready".
  let tail = '';
  if (homeDir) {
    const logFile = join(homeDir, 'test-daemon.log');
    if (existsSync(logFile)) {
      try {
        const full = readFileSync(logFile, 'utf-8');
        tail = '\n--- test-daemon.log (last 100 lines) ---\n' +
          full.split('\n').slice(-100).join('\n');
      } catch { /* best-effort */ }
    }
  }
  throw new Error(`Node on port ${port} did not become ready within ${maxWaitMs}ms${tail}`);
}

async function safeRemoveTestDir(): Promise<void> {
  if (!existsSync(TEST_DIR)) return;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      if (!existsSync(TEST_DIR)) return;
    } catch (err) {
      if (attempt === 19) throw err;
    }
    await sleep(500);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export interface ClusterOptions {
  chain?: boolean;
}

export async function startHardhatChain(): Promise<HardhatChain> {
  const logDir = join(TEST_DIR, 'hardhat');
  mkdirSync(logDir, { recursive: true });

  // Remove stale deployment artifacts
  try {
    rmSync(join(EVM_MODULE, 'deployments', 'hardhat_contracts.json'), { force: true });
    rmSync(join(EVM_MODULE, 'deployments', 'localhost_contracts.json'), { force: true });
  } catch { /* ignore */ }

  const child = spawn(
    'npx',
    ['hardhat', 'node', '--port', String(HARDHAT_E2E_PORT), '--no-deploy'],
    { cwd: EVM_MODULE, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const logStream = createWriteStream(join(logDir, 'node.log'), { flags: 'a' });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  const rpcUrl = `http://127.0.0.1:${HARDHAT_E2E_PORT}`;

  // Wait for Hardhat RPC to be responsive
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
      });
      if (res.ok) break;
    } catch { /* not ready */ }
    await sleep(500);
  }

  // Deploy contracts
  const deployLog = execSync(
    `npx hardhat deploy --network localhost`,
    {
      cwd: EVM_MODULE,
      env: { ...process.env, RPC_LOCALHOST: rpcUrl },
      timeout: 60_000,
    },
  ).toString();

  // Extract Hub address from deploy output
  const hubMatch = deployLog.match(/deploying "Hub".*deployed at (0x[a-fA-F0-9]+)/);
  let hubAddress = hubMatch?.[1] ?? '';
  if (!hubAddress) {
    try {
      const contracts = JSON.parse(
        readFileSync(join(EVM_MODULE, 'deployments', 'localhost_contracts.json'), 'utf-8'),
      );
      hubAddress = contracts.contracts?.Hub?.evmAddress ?? '';
    } catch { /* ignore */ }
  }
  if (!hubAddress) throw new Error('Failed to extract Hub address from deploy');

  // Lower minimumRequiredSignatures to 1 (default is 3, but the agent
  // doesn't yet collect peer receiver signatures via RTP).
  try {
    const contractsPath = join(EVM_MODULE, 'deployments', 'localhost_contracts.json');
    const contracts = JSON.parse(readFileSync(contractsPath, 'utf-8'));
    const psAddr = contracts.contracts?.ParametersStorage?.evmAddress;
    if (psAddr) {
      const body = JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_sendTransaction',
        params: [{
          from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // hardhat account 0
          to: psAddr,
          data: '0xf7ae9b6e' + '0000000000000000000000000000000000000000000000000000000000000001', // setMinimumRequiredSignatures(1)
        }],
      });
      const resp = execSync(`curl -s -X POST "${rpcUrl}" -H "Content-Type: application/json" -d '${body}'`, { timeout: 5_000 }).toString();
      try {
        const parsed = JSON.parse(resp);
        if (parsed.error) console.warn(`setMinimumRequiredSignatures failed: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
      } catch { /* non-JSON response */ }
    }
  } catch { /* best-effort */ }

  return { process: child, rpcUrl, hubAddress, port: HARDHAT_E2E_PORT };
}

export async function stopHardhat(chain: HardhatChain): Promise<void> {
  if (!chain.process || chain.process.exitCode !== null) return;

  chain.process.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>(resolve => chain.process!.once('exit', () => resolve(true))),
    sleep(3000).then(() => false),
  ]);
  if (!exited && chain.process.exitCode === null) {
    chain.process.kill('SIGKILL');
    await Promise.race([
      new Promise<void>(resolve => chain.process!.once('exit', () => resolve())),
      sleep(2000),
    ]);
  }
}

function fundWallet(rpcUrl: string, address: string): void {
  const amount = '0x56BC75E2D63100000'; // 100 ETH
  execSync(`curl -s -X POST "${rpcUrl}" -H "Content-Type: application/json" -d '${JSON.stringify({
    jsonrpc: '2.0', method: 'hardhat_setBalance', params: [address, amount], id: 1,
  })}'`, { timeout: 5_000 });
}

export async function startTestCluster(nodeCount: number, options?: ClusterOptions): Promise<TestNode[]> {
  // Retry the dir wipe — in CI, a previous test file's daemon process may
  // still be finalising log flushes when we try to rmSync here, which
  // surfaces as ENOTEMPTY. safeRemoveTestDir polls until the directory is
  // genuinely gone before we rebuild it.
  await safeRemoveTestDir();
  mkdirSync(TEST_DIR, { recursive: true });

  const authToken = 'test-token-for-e2e';

  // Optionally start Hardhat chain
  let chain: HardhatChain | undefined;
  if (options?.chain) {
    chain = await startHardhatChain();
    // Store chain ref so stopTestCluster can clean it up
    (globalThis as any).__e2eHardhat = chain;
  }

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
      contextGraphs: ['origin-trail-game'],
      auth: { enabled: true, tokens: [authToken] },
    };

    if (isRelay) {
      config.relay = 'none';
    }

    if (chain) {
      config.chain = {
        type: 'evm',
        rpcUrl: chain.rpcUrl,
        hubAddress: chain.hubAddress,
        chainId: 'evm:31337',
      };

      const hw = HARDHAT_WALLETS[i % HARDHAT_WALLETS.length];
      writeFileSync(
        join(homeDir, 'wallets.json'),
        JSON.stringify({ wallets: [{ privateKey: hw.key, address: hw.address }] }, null, 2),
      );

      fundWallet(chain.rpcUrl, hw.address);
    }

    writeFileSync(join(homeDir, 'config.json'), JSON.stringify(config, null, 2));
    writeFileSync(join(homeDir, 'auth.token'), authToken);

    nodes.push({ index: i, apiPort, libp2pPort, homeDir, process: null as any, authToken });
  }

  // Start node 1 (relay) first
  nodes[0].process = startDaemon(nodes[0]);
  // Internal timeout must be strictly LESS than the outer beforeAll's
  // hookTimeout so our diagnostic "did not become ready + daemon log tail"
  // error materialises before vitest's generic "Hook timed out" kicks in
  // and unmounts the error with no useful context. Individual test files
  // use a 10-minute beforeAll; a 4-minute boot window per node is plenty.
  await waitForReady(nodes[0].apiPort, 240_000, nodes[0].homeDir);

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
  await Promise.all(nodes.slice(1).map(n => waitForReady(n.apiPort, 240_000, n.homeDir)));

  // Set default ask price for node identities (otherwise stakeWeightedAverageAsk = 0
  // and publish tokenAmount calculates to 0 which the contract rejects).
  if (chain) {
    try {
      const contractsPath = join(EVM_MODULE, 'deployments', 'localhost_contracts.json');
      const contracts = JSON.parse(readFileSync(contractsPath, 'utf-8'));
      const profileAddr = contracts.contracts?.Profile?.evmAddress;
      if (profileAddr) {
        // updateAsk(uint72 identityId, uint96 ask) — 1 TRAC = 0x0de0b6b3a7640000
        // Resolve each node's identity ID via IdentityStorage.getIdentityId(address)
        // selector: 0xd7236ebf (getIdentityId(address))
        const askData = '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
        const identityStorageAddr = contracts.contracts?.IdentityStorage?.evmAddress;
        for (let i = 0; i < nodeCount; i++) {
          const hw = HARDHAT_WALLETS[i % HARDHAT_WALLETS.length];
          let identityId = i + 1;
          if (identityStorageAddr) {
            try {
              const callData = '0xd7236ebf' + hw.address.slice(2).padStart(64, '0');
              const callBody = JSON.stringify({
                jsonrpc: '2.0', id: 1, method: 'eth_call',
                params: [{ to: identityStorageAddr, data: callData }, 'latest'],
              });
              const result = execSync(
                `curl -s -X POST "${chain.rpcUrl}" -H "Content-Type: application/json" -d '${callBody}'`,
                { timeout: 5_000 },
              ).toString();
              const parsed = JSON.parse(result);
              if (parsed.error) {
                console.warn(`getIdentityId failed for node ${i}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
              } else if (parsed.result && parsed.result !== '0x' && parsed.result !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
                identityId = parseInt(parsed.result, 16);
              }
            } catch { /* fall back to sequential i+1 */ }
          }
          const idHex = identityId.toString(16).padStart(64, '0');
          const data = '0xc740e04c' + idHex + askData;
          const body = JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'eth_sendTransaction',
            params: [{ from: hw.address, to: profileAddr, data }],
          });
          execSync(`curl -s -X POST "${chain.rpcUrl}" -H "Content-Type: application/json" -d '${body}'`, { timeout: 5_000 });
        }
      }
    } catch { /* best-effort */ }
  }

  // Wait for gossipsub mesh to form (extra time with chain for identity creation)
  await sleep(chain ? 8000 : 3000);

  return nodes;
}

function startDaemon(node: TestNode): ChildProcess {
  const child = spawn(
    process.execPath,
    [CLI_JS, 'start', '--foreground'],
    {
      cwd: DKG_V9_ROOT,
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
  const alive = nodes.filter(n => n.process && n.process.exitCode === null);
  for (const node of alive) {
    node.process!.kill('SIGTERM');
  }

  // Wait up to 5s for clean shutdown, then force-kill any stragglers.
  const waitExit = (n: TestNode, timeoutMs: number): Promise<boolean> =>
    Promise.race([
      new Promise<boolean>(resolve => n.process!.once('exit', () => resolve(true))),
      sleep(timeoutMs).then(() => false),
    ]);
  await Promise.all(alive.map(n => waitExit(n, 5000)));

  const stillAlive = alive.filter(n => n.process!.exitCode === null);
  for (const node of stillAlive) {
    node.process!.kill('SIGKILL');
  }
  // Give SIGKILL'd processes a moment to release file handles so the next
  // test file's `rmSync(TEST_DIR)` doesn't race with a writing daemon.
  await Promise.all(stillAlive.map(n => waitExit(n, 3000)));
  await sleep(500);

  const chain = (globalThis as any).__e2eHardhat as HardhatChain | undefined;
  if (chain) {
    await stopHardhat(chain);
    (globalThis as any).__e2eHardhat = undefined;
  }
}

export function nodeApi(node: TestNode) {
  const base = `http://127.0.0.1:${node.apiPort}`;
  const token = node.authToken;
  const game = `${base}/api/apps/origin-trail-game`;

  return {
    status: () => httpGet(`${base}/api/status`),
    apps: () => httpGet(`${base}/api/apps`, token),
    createParanet: (id: string, name: string, description?: string) =>
      httpPost(`${base}/api/context-graph/create`, { id, name, description }, token),
    createContextGraph: (id: string, name: string, description?: string) =>
      httpPost(`${base}/api/context-graph/create`, { id, name, description }, token),
    listParanets: () => httpGet(`${base}/api/context-graph/list`, token),
    publishCclPolicy: (body: {
      paranetId: string;
      name: string;
      version: string;
      content: string;
      description?: string;
      contextType?: string;
      language?: string;
      format?: string;
    }) => httpPost(`${base}/api/ccl/policy/publish`, body, token),
    approveCclPolicy: (body: {
      paranetId: string;
      policyUri: string;
      contextType?: string;
    }) => httpPost(`${base}/api/ccl/policy/approve`, body, token),
    resolveCclPolicy: (paranetId: string, name: string, opts?: { contextType?: string; includeBody?: boolean }) => {
      const params = new URLSearchParams({ paranetId, name });
      if (opts?.contextType) params.set('contextType', opts.contextType);
      if (opts?.includeBody) params.set('includeBody', 'true');
      return httpGet(`${base}/api/ccl/policy/resolve?${params.toString()}`, token);
    },
    evaluateCclPolicy: (body: {
      paranetId: string;
      name: string;
      facts: Array<[string, ...unknown[]]>;
      contextType?: string;
      view?: string;
      snapshotId?: string;
      scopeUal?: string;
      publishResult?: boolean;
    }) => httpPost(`${base}/api/ccl/eval`, body, token),
    listCclEvaluations: (paranetId: string, opts?: {
      policyUri?: string;
      snapshotId?: string;
      view?: string;
      contextType?: string;
      resultKind?: 'derived' | 'decision';
      resultName?: string;
    }) => {
      const params = new URLSearchParams({ paranetId });
      if (opts?.policyUri) params.set('policyUri', opts.policyUri);
      if (opts?.snapshotId) params.set('snapshotId', opts.snapshotId);
      if (opts?.view) params.set('view', opts.view);
      if (opts?.contextType) params.set('contextType', opts.contextType);
      if (opts?.resultKind) params.set('resultKind', opts.resultKind);
      if (opts?.resultName) params.set('resultName', opts.resultName);
      return httpGet(`${base}/api/ccl/results?${params.toString()}`, token);
    },
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

/** Read a test node's daemon log file. */
export function readNodeLog(node: TestNode): string {
  const logFile = join(node.homeDir, 'test-daemon.log');
  try {
    return readFileSync(logFile, 'utf-8');
  } catch {
    return '';
  }
}

/** Extract [OriginTrailGame] lines from a node's log. */
export function gameLogLines(node: TestNode): string[] {
  return readNodeLog(node)
    .split('\n')
    .filter(l => l.includes('[OriginTrailGame]') || l.includes('Context graph') || l.includes('publish') || l.includes('identityId'));
}
