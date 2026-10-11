/**
 * A daemon whose EVM signing is delegated to an external signer, booted from
 * the built CLI against the shared Hardhat node. The signer (an in-process
 * stand-in) serves the payer accounts to one credential and the author keys to
 * another, over a unix socket. The node must start without creating a key file,
 * report the signer's payer accounts, register an agent by an address the
 * signer holds (the registration is signed by the signer), refuse a payer
 * account as an agent, create and register a context graph with the node token
 * (curated by its default agent, the configured author), run the whole publish
 * journey into a PCA-backed public graph with a curated publish policy (a core
 * node holding the Hardhat core profile's keys hosts it and acknowledges
 * storage), keep the credentials out of its output, and refuse to start as a
 * core node.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, contextGraphDataUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TEST_SNAPSHOT_STORAGE } from '../../../scripts/testing/snapshot-storage.js';
import {
  createEVMAdapter,
  createProvider,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { makeAdapterConfig, mintTokens } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const PAYER_TOKEN = 'daemon-payer-credential-0a1b2c3d4e5f6789';
const AUTHOR_TOKEN = 'daemon-author-credential-9876f5e4d3c2b1a0';
const payers = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
const defaultAuthor = ethers.Wallet.createRandom();
const agentKey = ethers.Wallet.createRandom();
const JOURNEY_CG = 'external-signer-journey';
const JOURNEY_ENTITY = 'urn:external-signer-journey:entity';

/** The length-framed fields (uint32 big-endian length, then the bytes) of a gossip signing payload. */
function framedFields(bytes: Uint8Array): Uint8Array[] {
  const fields: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
    fields.push(bytes.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return fields;
}

interface Daemon {
  home: string;
  apiPort: number;
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

async function freePort(excluded: ReadonlySet<number> = new Set()): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!address || typeof address === 'string') throw new Error('no TCP port');
    if (!excluded.has(address.port)) return address.port;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnDaemon(
  home: string,
  nodeRole: 'edge' | 'core',
  socketPath: string,
  bootstrapPeers: string[] = [],
): Promise<Daemon> {
  const { rpcUrl, hubAddress } = getSharedContext();
  const apiPort = await freePort();
  const tokenFile = join(home, 'signer.token');
  const authorTokenFile = join(home, 'signer-author.token');
  await writeFile(tokenFile, `${PAYER_TOKEN}\n`);
  await writeFile(authorTokenFile, `${AUTHOR_TOKEN}\n`);
  await chmod(tokenFile, 0o600);
  await chmod(authorTokenFile, 0o600);
  await writeFile(join(home, 'config.json'), JSON.stringify({
    sharedMemoryPublicSnapshotStorage: TEST_SNAPSHOT_STORAGE,
    name: 'external-signer-test',
    apiPort,
    listenPort: await freePort(new Set([apiPort])),
    apiHost: '127.0.0.1',
    nodeRole,
    relay: 'none',
    ...(bootstrapPeers.length > 0 ? { bootstrapPeers } : {}),
    auth: { enabled: true },
    store: { backend: 'oxigraph-worker', options: { path: join(home, 'store.nq') } },
    chain: {
      type: 'evm',
      rpcUrl,
      hubAddress,
      chainId: 'evm:31337',
      signer: {
        type: 'remote',
        socketPath,
        authTokenFile: tokenFile,
        author: { authTokenFile: authorTokenFile, address: defaultAuthor.address },
      },
    },
    contextGraphs: [],
  }));
  const child = spawn('node', [CLI_ENTRY, 'daemon-worker'], {
    env: {
      ...process.env,
      DKG_HOME: home,
      DKG_API_PORT: String(apiPort),
      DKG_NO_BLUE_GREEN: '1',
      DKG_DISABLE_TELEMETRY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr!.on('data', (chunk: Buffer) => chunks.push(chunk));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { home, apiPort, child, exited, output: () => Buffer.concat(chunks).toString('utf8') };
}

/** What the daemon printed plus its daemon.log (a detached worker logs to the file only). */
async function allOutput(daemon: Daemon): Promise<string> {
  const logFile = join(daemon.home, 'daemon.log');
  return daemon.output() + (existsSync(logFile) ? await readFile(logFile, 'utf8') : '');
}

async function waitUntilReady(daemon: Daemon): Promise<void> {
  for (let i = 0; i < 90; i++) {
    if (daemon.child.exitCode !== null) {
      throw new Error(`daemon exited early with code ${daemon.child.exitCode}:\n${(await allOutput(daemon)).slice(-4000)}`);
    }
    try {
      if ((await fetch(`http://127.0.0.1:${daemon.apiPort}/api/status`)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`daemon did not become ready within 45s:\n${(await allOutput(daemon)).slice(-4000)}`);
}

async function stop(daemon: Daemon | undefined): Promise<number | null> {
  if (!daemon) return null;
  if (daemon.child.exitCode !== null) return daemon.child.exitCode;
  daemon.child.kill('SIGTERM');
  const code = await Promise.race([daemon.exited, sleep(10_000).then(() => 'timeout' as const)]);
  if (code === 'timeout') {
    daemon.child.kill('SIGKILL');
    throw new Error('daemon did not exit within 10s of SIGTERM');
  }
  return code;
}

describe('daemon with an external signer', () => {
  let dir: string;
  let fake: FakeSigner;
  let daemon: Daemon | undefined;
  let adminToken: string;
  let snapshotId: string | undefined;
  let pcaOwner: ReturnType<typeof createEVMAdapter> | undefined;
  let accountId: bigint;
  let core: DKGAgent | undefined;

  const api = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${daemon!.apiPort}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', ...init.headers },
  });

  beforeAll(async () => {
    if (!existsSync(CLI_ENTRY)) throw new Error(`CLI not built at ${CLI_ENTRY}`);
    snapshotId = await takeSnapshot();
    // Payers with gas and TRAC, registered as agents of a Publishing Conviction
    // Account so that they may publish into the graph it backs.
    const provider = createProvider();
    const { hubAddress } = getSharedContext();
    const deployer = new ethers.Wallet(HARDHAT_KEYS.DEPLOYER, provider);
    for (const payer of payers) {
      await (await deployer.sendTransaction({ to: payer.address, value: ethers.parseEther('1') })).wait();
      await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, payer.address, ethers.parseEther('1000'));
    }
    pcaOwner = createEVMAdapter(HARDHAT_KEYS.EXTRA1);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, pcaOwner.getSignerAddress(), ethers.parseEther('100000'));
    ({ accountId } = await pcaOwner.createPublishingConvictionAccount(ethers.parseEther('100000')));
    for (const payer of payers) await pcaOwner.registerPublishingConvictionAgent(accountId, payer.address);
    // A core node with the Hardhat core profile's keys, for storage acknowledgements.
    core = await DKGAgent.create({
      name: 'external-signer-test-core',
      store: new OxigraphStore(),
      listenHost: '127.0.0.1',
      listenPort: 0,
      nodeRole: 'core',
      chainAdapter: new EVMChainAdapter(makeAdapterConfig(getSharedContext().rpcUrl, getSharedContext().hubAddress, HARDHAT_KEYS.CORE_OP)),
      rfc64CatalogActivation: { enabled: false },
      syncOnConnectEnabled: false,
    });
    await core.start();
    const coreAddress = core.multiaddrs.find((address) => address.includes('/tcp/') && !address.includes('/p2p-circuit'))!;
    dir = await mkdtemp(join(tmpdir(), 'dkg-ext-'));
    fake = await startFakeRemoteSigner({
      socketPath: join(dir, 'signer.sock'),
      credentials: [
        { token: PAYER_TOKEN, keys: payers.map((payer) => payer.privateKey) },
        { token: AUTHOR_TOKEN, keys: [defaultAuthor.privateKey, agentKey.privateKey] },
      ],
    });
    const home = join(dir, 'edge');
    await mkdir(home);
    daemon = await spawnDaemon(home, 'edge', fake.socketPath!, [coreAddress]);
    await waitUntilReady(daemon);
    adminToken = (await readFile(join(home, 'auth.token'), 'utf8'))
      .split('\n').map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith('#'))!;
  }, 120_000);

  afterAll(async () => {
    try {
      expect(await stop(daemon)).toBe(0);
    } finally {
      await core?.stop().catch(() => {});
      pcaOwner?.destroy();
      await fake?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
      if (snapshotId) await revertSnapshot(snapshotId);
    }
  }, 30_000);

  it('starts without a key file and reports the signer\'s payer accounts', async () => {
    const home = daemon!.home;
    expect(existsSync(join(home, 'wallets.json'))).toBe(false);
    expect(existsSync(join(home, 'wallets.key'))).toBe(false);
    expect(fake.calls('eth_accounts').map((request) => request.authorization).sort())
      .toEqual([`Bearer ${AUTHOR_TOKEN}`, `Bearer ${PAYER_TOKEN}`]);

    const wallets = await (await api('/api/wallets')).json() as { wallets: string[] };
    expect(wallets.wallets).toEqual(payers.map((payer) => payer.address));
    const operational = await (await api('/api/operational-wallets')).json() as {
      adminKeyConfigured: boolean;
      canManage: boolean;
      wallets: Array<{ address: string; isAdmin: boolean }>;
    };
    expect(operational.adminKeyConfigured).toBe(false);
    expect(operational.canManage).toBe(false);
    expect(operational.wallets.map((wallet) => wallet.address)).toEqual(payers.map((payer) => payer.address));
  });

  it('registers an agent by an address the signer holds, and refuses a payer account', async () => {
    const before = fake.calls('eth_signTypedData_v4').length;
    const res = await api('/api/agent/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'external-writer', address: agentKey.address }),
    });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ agentAddress: agentKey.address, mode: 'self-sovereign' });
    expect(typeof body.authToken).toBe('string');
    expect(body).not.toHaveProperty('privateKey');
    const signed = fake.calls('eth_signTypedData_v4').slice(before);
    expect(signed).toHaveLength(1);
    expect(signed[0].authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(ethers.getAddress(String(signed[0].params[0]))).toBe(agentKey.address);

    const refused = await api('/api/agent/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'payer-as-agent', address: payers[0].address }),
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/not an author key of the external signer/);
  });

  it('creates and registers a context graph with the node token, curated by the default author', async () => {
    const res = await api('/api/context-graph/create', {
      method: 'POST',
      body: JSON.stringify({ id: 'external-signer-node-graph', name: 'Node token graph', register: true }),
    });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body, JSON.stringify(body)).toMatchObject({ registered: true, onChainId: expect.any(String) });
    const transactions = fake.calls('eth_signTransaction');
    expect(transactions.length).toBeGreaterThan(0);
    expect(transactions.every((request) => request.authorization === `Bearer ${PAYER_TOKEN}`)).toBe(true);
    expect(await allOutput(daemon!)).toContain(`Auto-registered default agent "external-signer-test" → ${defaultAuthor.address}`);
  });

  it('runs the publish journey with the node token and no local key', async () => {
    const created = await api('/api/context-graph/create', {
      method: 'POST',
      body: JSON.stringify({
        id: JOURNEY_CG,
        name: 'External signer journey',
        register: true,
        accessPolicy: 0,
        publishPolicy: 0,
        pcaAccountId: accountId.toString(),
      }),
    });
    const graph = await created.json() as { registered?: boolean; onChainId?: string };
    expect(created.status).toBe(200);
    expect(graph, JSON.stringify(graph)).toMatchObject({ registered: true, onChainId: expect.any(String) });
    // The core hosts the graph.
    await core!.store.insert([{
      subject: contextGraphDataUri(JOURNEY_CG),
      predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
      object: `"${graph.onChainId}"`,
      graph: contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
    }]);
    core!.subscribeToContextGraph(JOURNEY_CG);
    await sleep(2_000);

    const before = fake.requests.length;
    const shared = await api('/api/knowledge-assets', {
      method: 'POST',
      body: JSON.stringify({
        contextGraphId: JOURNEY_CG,
        name: 'journey-asset',
        quads: [{ subject: JOURNEY_ENTITY, predicate: 'http://schema.org/name', object: '"Journey entity"' }],
        alsoShareSwm: true,
        // The node is the curator: no acknowledgement round trip is needed.
        awaitCuratorAck: true,
      }),
    });
    const share = await shared.json() as Record<string, unknown>;
    expect(shared.status, JSON.stringify(share)).toBe(201);
    expect(share).toMatchObject({ swmShared: true });
    let received = 0;
    for (let attempt = 0; attempt < 40 && received === 0; attempt++) {
      const rows = await core!.query(
        `SELECT ?name WHERE { <${JOURNEY_ENTITY}> <http://schema.org/name> ?name }`,
        { contextGraphId: JOURNEY_CG, graphSuffix: '_shared_memory' },
      );
      received = rows.bindings.length;
      if (received === 0) await sleep(500);
    }
    expect(received).toBe(1);

    const published = await api('/api/knowledge-assets/journey-asset/vm/publish', {
      method: 'POST',
      body: JSON.stringify({ contextGraphId: JOURNEY_CG }),
    });
    const publish = await published.json() as Record<string, unknown>;
    expect(published.status, JSON.stringify(publish)).toBe(200);

    // The author key signed the author attestation, the shared-memory gossip
    // envelope (four length-framed fields: type, context graph, timestamp,
    // payload) and, where RFC-64 catalog authority is active, the control
    // objects the author issues (EIP-191 over 32-byte object digests); the
    // payers signed transactions only.
    const journey = fake.requests.slice(before);
    const author = journey.filter((request) => request.authorization === `Bearer ${AUTHOR_TOKEN}`);
    expect(author.filter((request) => request.method === 'eth_signTypedData_v4')).toHaveLength(1);
    const messages = author.filter((request) => request.method === 'eth_sign');
    expect(messages.length + 1).toBe(author.length);
    for (const message of messages) expect(ethers.getAddress(String(message.params[0]))).toBe(defaultAuthor.address);
    const isDigest = (request: (typeof messages)[number]) => ethers.getBytes(String(request.params[1])).length === 32;
    const envelopes = messages.filter((request) => !isDigest(request));
    expect(envelopes).toHaveLength(1);
    const fields = framedFields(ethers.getBytes(String(envelopes[0]!.params[1])));
    expect(fields).toHaveLength(4);
    expect(new TextDecoder().decode(fields[0])).toBe('share-write');
    expect(new Set(journey.filter((request) => request.authorization === `Bearer ${PAYER_TOKEN}`)
      .map((request) => request.method))).toEqual(new Set(['eth_signTransaction']));
    // Since the node started, no message or digest was signed with a payer key.
    expect(fake.requests.filter((request) => (
      request.authorization === `Bearer ${PAYER_TOKEN}` && /sign(?!Transaction)/i.test(request.method)
    ))).toEqual([]);
  }, 180_000);

  it('logs the signer endpoint and accounts but never a credential', async () => {
    const output = await allOutput(daemon!);
    expect(output).toContain('external signer at');
    expect(output).toContain(payers[1].address);
    expect(output).toContain(defaultAuthor.address);
    expect(output).not.toContain(PAYER_TOKEN);
    expect(output).not.toContain(AUTHOR_TOKEN);
  });

  it('refuses to start as a core node, before any key file exists', async () => {
    const home = join(dir, 'core');
    await mkdir(home);
    const core = await spawnDaemon(home, 'core', fake.socketPath!);
    const code = await Promise.race([core.exited, sleep(60_000).then(() => 'timeout' as const)]);
    if (code === 'timeout') core.child.kill('SIGKILL');
    expect(code).toBe(1);
    expect(await allOutput(core)).toMatch(/FATAL: .*edge nodes only/);
    expect(existsSync(join(home, 'wallets.json'))).toBe(false);
  }, 90_000);
});
