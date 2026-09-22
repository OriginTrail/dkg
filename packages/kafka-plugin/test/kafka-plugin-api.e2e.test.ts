/** kafka-plugin live-daemon E2E. Mirrors packages/cli/test/daemon/plugin-routes-api.e2e.test.ts. */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { getSharedContext } from '../../chain/test/evm-test-context.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { PROTOCOL_STORAGE_ACK_V2 } from '../../core/src/constants.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolvePath(__dirname, '..', '..', 'cli', 'dist', 'cli.js');
const BARE_FIXTURE_DIR = resolvePath(
  __dirname,
  '..',
  '..',
  'cli',
  'test-fixtures',
  'sample-kafka-plugin',
);
const BARE_FIXTURE = join(BARE_FIXTURE_DIR, 'dist', 'index.js');
const EXTENSION_FIXTURE_DIR = resolvePath(
  __dirname,
  '..',
  '..',
  'cli',
  'test-fixtures',
  'sample-kafka-extension',
);
const EXTENSION_FIXTURE = join(EXTENSION_FIXTURE_DIR, 'dist', 'index.js');
const KAFKA_PLUGIN_PACKAGE_DIR = resolvePath(__dirname, '..');
const KAFKA_PLUGIN_ENTRYPOINT = join(KAFKA_PLUGIN_PACKAGE_DIR, 'dist', 'index.js');
const CORE_OP_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const REC1_OP_ADDRESS = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
interface Daemon {
  home: string;
  apiPort: number;
  listenPort: number;
  child: ChildProcess;
  token: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}
// A probed port is free again once the probe closes, so the OS can offer it
// twice. Remembering every port handed out keeps all daemons' ports distinct.
const allocatedPorts = new Set<number>();
async function allocatePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const probe = createServer();
    // libp2p binds 0.0.0.0; a port free there is also free for the API on 127.0.0.1.
    const port = await new Promise<number>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '0.0.0.0', () => resolve((probe.address() as AddressInfo).port));
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    if (!allocatedPorts.has(port)) {
      allocatedPorts.add(port);
      return port;
    }
  }
  throw new Error('Could not allocate a port that no other daemon in this file uses');
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function ensureFixtureEntrypoint(packageDir: string, entrypoint: string): Promise<void> {
  const child = spawn('pnpm', ['--dir', packageDir, 'run', 'build'], {
    cwd: resolvePath(__dirname, '..', '..', '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) {
    throw new Error(
      `Failed to build kafka-plugin fixture at ${packageDir} (exit ${code}).\n${output.trim()}`,
    );
  }
  if (!existsSync(entrypoint)) {
    throw new Error(`Built kafka-plugin fixture at ${packageDir}, but ${entrypoint} is still missing.`);
  }
}
interface FixtureEntrypoint {
  packageDir: string;
  entrypoint: string;
}
const KAFKA_PLUGIN_FIXTURES: FixtureEntrypoint[] = [
  { packageDir: BARE_FIXTURE_DIR, entrypoint: BARE_FIXTURE },
  { packageDir: EXTENSION_FIXTURE_DIR, entrypoint: EXTENSION_FIXTURE },
];
async function ensureKafkaPluginFixtures(
  fixtures = KAFKA_PLUGIN_FIXTURES,
  buildPackage = ensureFixtureEntrypoint,
): Promise<void> {
  await buildPackage(KAFKA_PLUGIN_PACKAGE_DIR, KAFKA_PLUGIN_ENTRYPOINT);
  for (const fixture of fixtures) {
    await buildPackage(fixture.packageDir, fixture.entrypoint);
  }
}
async function copyFixtureWithoutDist(sourceDir: string): Promise<FixtureEntrypoint & { tempRoot: string }> {
  const packageDir = await mkdtemp(resolvePath(__dirname, '..', '..', 'cli', 'test-fixtures', '.tmp-kafka-fixture-'));
  await rm(packageDir, { recursive: true, force: true });
  await cp(sourceDir, packageDir, { recursive: true });
  await rm(join(packageDir, 'dist'), { recursive: true, force: true });
  const packageJsonPath = join(packageDir, 'package.json');
  const pkg = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
  pkg.dependencies['@origintrail-official/kafka-plugin'] = `file:${KAFKA_PLUGIN_PACKAGE_DIR}`;
  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return { tempRoot: packageDir, packageDir, entrypoint: join(packageDir, 'dist', 'index.js') };
}
interface DaemonOpts {
  pluginPath?: string;
  cgId?: string;
  nodeRole?: 'core' | 'edge';
  bootstrapPeers?: string[];
  wallet?: { address: string; privateKey: string };
}
async function writeDaemonConfig(
  home: string,
  apiPort: number,
  listenPort: number,
  opts: DaemonOpts,
): Promise<void> {
  const { rpcUrl, hubAddress } = getSharedContext();
  const wallet = opts.wallet ?? { address: CORE_OP_ADDRESS, privateKey: HARDHAT_KEYS.CORE_OP };
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      name: opts.pluginPath ? 'kafka-plugin-e2e' : 'kafka-plugin-ack-core-e2e',
      apiPort,
      listenPort,
      apiHost: '127.0.0.1',
      nodeRole: opts.nodeRole ?? 'edge',
      relay: 'none',
      ...(opts.bootstrapPeers?.length ? { bootstrapPeers: opts.bootstrapPeers } : {}),
      auth: { enabled: true },
      store: {
        backend: 'oxigraph-worker',
        options: { path: join(home, 'store.nq') },
      },
      chain: {
        type: 'evm',
        rpcUrl,
        hubAddress,
        chainId: 'evm:31337',
      },
      contextGraphs: [],
      publisher: { enabled: Boolean(opts.pluginPath) },
      sharedMemoryPublicSnapshotStorage: { enabled: false },
      ...(opts.cgId ? { kafka: { contextGraphId: opts.cgId } } : {}),
      routePlugins: opts.pluginPath ? [opts.pluginPath] : [],
    }),
  );
  const walletEntry = JSON.stringify({
    wallets: [wallet],
  }, null, 2) + '\n';
  await writeFile(join(home, 'wallets.json'), walletEntry, { mode: 0o600 });
  await writeFile(join(home, 'publisher-wallets.json'), walletEntry, { mode: 0o600 });
}
class DaemonExitedEarly extends Error {}
async function startDaemon(opts: DaemonOpts): Promise<Daemon> {
  if (opts.pluginPath) await ensureKafkaPluginFixtures();
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `CLI not built at ${CLI_ENTRY}. Run \`pnpm --filter @origintrail-official/dkg build\` first.`,
    );
  }
  if (opts.pluginPath) {
    await ensureFixtureEntrypoint(dirname(dirname(opts.pluginPath)), opts.pluginPath);
  }
  try {
    return await launchDaemon(opts);
  } catch (err) {
    // Each port was free when probed, but another process can bind it before
    // the daemon does. That race ends in EADDRINUSE; retry it once on new ports.
    if (!(err instanceof DaemonExitedEarly) || !err.message.includes('EADDRINUSE')) throw err;
    return launchDaemon(opts);
  }
}
async function launchDaemon(opts: DaemonOpts): Promise<Daemon> {
  const home = await mkdtemp(join(tmpdir(), 'dkg-kafka-plugin-e2e-'));
  const apiPort = await allocatePort();
  const listenPort = await allocatePort();
  await writeDaemonConfig(home, apiPort, listenPort, opts);
  const stdioLog = join(home, 'daemon-stdio.log');
  const logHandle = await open(stdioLog, 'a');
  const child = spawn('node', [CLI_ENTRY, 'daemon-worker'], {
    env: {
      ...process.env,
      DKG_HOME: home,
      DKG_API_PORT: String(apiPort),
      DKG_NO_BLUE_GREEN: '1',
      DKG_DISABLE_TELEMETRY: '1',
    },
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  const tail = async (n = 80): Promise<string> => {
    try {
      const buf = await readFile(stdioLog, 'utf-8');
      return buf.split('\n').slice(-n).join('\n').trim();
    } catch {
      return '<could not read daemon stdio log>';
    }
  };
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  // An API port conflict is logged only to daemon.log, a libp2p one only to stdio.
  const exitedEarly = async (): Promise<DaemonExitedEarly> => {
    const daemonLog = await readFile(join(home, 'daemon.log'), 'utf-8').catch(() => '<could not read daemon.log>');
    return new DaemonExitedEarly(
      `Daemon exited early (code=${child.exitCode}, signal=${child.signalCode}).\n` +
      `--- daemon stdio tail ---\n${await tail()}\n` +
      `--- daemon.log tail ---\n${daemonLog.split('\n').slice(-40).join('\n').trim()}`,
    );
  };
  const daemon: Daemon = { home, apiPort, listenPort, child, token: '' };
  child.once('exit', (code, signal) => {
    daemon.exitCode = code;
    daemon.signal = signal;
  });
  try {
    for (let i = 0; i < 90; i++) {
      if (exited()) throw await exitedEarly();
      let ok = false;
      try {
        ok = (await fetch(`http://127.0.0.1:${apiPort}/api/status`)).ok;
      } catch { /* not ready yet */ }
      // /api/status needs no token, so a daemon already on this port answers it
      // too. auth.token appears before this daemon listens and api.port only
      // after it has bound the port; with a live child they prove the 200 is ours.
      if (ok) {
        if (exited()) throw await exitedEarly();
        if (existsSync(join(home, 'auth.token')) && existsSync(join(home, 'api.port'))) break;
      }
      await sleep(500);
      if (i === 89) {
        throw new Error(
          `Daemon did not become ready within 45s.\n--- daemon stdio tail ---\n${await tail()}`,
        );
      }
    }
    await logHandle.close();
    const raw = await readFile(join(home, 'auth.token'), 'utf-8');
    const token = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('#'));
    if (!token) throw new Error('No auth token found in auth.token');
    daemon.token = token;
    if (opts.pluginPath) {
      let lastPublisherProbe = '';
      for (let i = 0; i < 40; i++) {
        const probe = await fetch(`http://127.0.0.1:${apiPort}/api/kafka/streams/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: '{}',
        });
        if (probe.status !== 503) break;
        lastPublisherProbe = await probe.text().catch(() => '<could not read publisher readiness probe body>');
        await sleep(500);
        if (i === 39) {
          throw new Error(
            `Publisher runtime did not become ready within 20s (last probe=${lastPublisherProbe}).\n` +
            `--- daemon stdio tail ---\n${await tail()}`,
          );
        }
      }
    }
    return daemon;
  } catch (err) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        sleep(5_000),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await logHandle.close().catch(() => {});
    await rm(home, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
async function daemonStatus(d: Daemon): Promise<any> {
  const res = await authed(d, 'GET', '/api/status');
  if (!res.ok) throw new Error(`GET /api/status failed: ${res.status} ${await res.text()}`);
  return res.json();
}
async function daemonBootstrapAddress(d: Daemon): Promise<{ address: string; peerId: string }> {
  const status = await daemonStatus(d);
  const peerId = String(status.peerId ?? '');
  const multiaddrs = Array.isArray(status.multiaddrs) ? status.multiaddrs.map(String) : [];
  const raw = multiaddrs.find((address: string) =>
    address.includes('/tcp/') && !address.includes('/p2p-circuit'),
  );
  if (!peerId || !raw) {
    throw new Error(`Core daemon has no dialable address: ${JSON.stringify({ peerId, multiaddrs })}`);
  }
  return {
    peerId,
    address: raw.includes('/p2p/') ? raw : `${raw}/p2p/${peerId}`,
  };
}
async function topologyLogTails(edge: Daemon, core: Daemon): Promise<string> {
  const [edgeLog, coreLog] = await Promise.all([
    readFile(join(edge.home, 'daemon-stdio.log'), 'utf-8').catch(() => '<no edge log>'),
    readFile(join(core.home, 'daemon-stdio.log'), 'utf-8').catch(() => '<no core log>'),
  ]);
  return `--- edge daemon log tail ---\n${edgeLog.split('\n').slice(-100).join('\n')}\n` +
    `--- core daemon log tail ---\n${coreLog.split('\n').slice(-100).join('\n')}`;
}
async function waitForStorageAckPeer(
  edge: Daemon,
  core: Daemon,
  peerId: string,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('StorageACK readiness deadline exceeded')), timeoutMs);
  let last: any = null;
  let requestError: unknown;
  try {
    while (!controller.signal.aborted && Date.now() < deadline) {
      const path = `/api/peer-info?peerId=${encodeURIComponent(peerId)}`;
      const responses = await Promise.all([
        authed(edge, 'GET', path, undefined, controller.signal),
        authed(core, 'GET', path, undefined, controller.signal),
      ]);
      const [edgePeer, coreSelf] = await Promise.all(responses.map((response) =>
        response.ok ? response.json() : { status: response.status },
      ));
      last = { edgePeer, coreSelf };
      if (controller.signal.aborted || Date.now() >= deadline) break;
      // A healthy HTTP listener and a connection do not prove StorageACK is
      // registered: transient chain failures defer it to a background retry.
      // Query the core's own peer store, which libp2p updates when it registers
      // handlers. The edge's cached identify advertisement can stay stale
      // after late registration, even while the core already accepts V2 ACKs.
      if (edgePeer.peerId === peerId && edgePeer.connected === true &&
          coreSelf.peerId === peerId && Array.isArray(coreSelf.peerStore?.protocols) &&
          coreSelf.peerStore.protocols.includes(PROTOCOL_STORAGE_ACK_V2)) return;
      await sleep(Math.max(0, Math.min(250, deadline - Date.now())));
    }
  } catch (error) {
    requestError = error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  throw new Error(
    `ACK core ${peerId} did not become ready for ${PROTOCOL_STORAGE_ACK_V2} within ${timeoutMs}ms ` +
    `(peer=${JSON.stringify(last)}, requestError=${String(requestError ?? 'none')})\n` +
    await topologyLogTails(edge, core),
  );
}
async function startLiveKafkaTopology(pluginPath: string, cgId: string): Promise<{
  core: Daemon;
  edge: Daemon;
}> {
  const core = await startDaemon({
    nodeRole: 'core',
    wallet: { address: REC1_OP_ADDRESS, privateKey: HARDHAT_KEYS.REC1_OP },
  });
  let edge: Daemon | null = null;
  try {
    const bootstrap = await daemonBootstrapAddress(core);
    edge = await startDaemon({
      pluginPath,
      cgId,
      bootstrapPeers: [bootstrap.address],
    });
    await waitForStorageAckPeer(edge, core, bootstrap.peerId);
    return { core, edge };
  } catch (err) {
    await stopDaemon(edge);
    await stopDaemon(core);
    throw err;
  }
}
async function stopDaemon(d: Daemon | null): Promise<void> {
  if (!d) return;
  if (d.child.exitCode === null) {
    const exited = new Promise<void>((resolve) => d.child.once('exit', () => resolve()));
    d.child.kill('SIGTERM');
    await Promise.race([exited, sleep(10_000)]);
    if (d.child.exitCode === null) d.child.kill('SIGKILL');
  }
  await rm(d.home, { recursive: true, force: true }).catch(() => {});
}
async function authed(
  d: Daemon,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${d.token}` };
  const init: RequestInit = { method, headers, ...(signal ? { signal } : {}) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(`http://127.0.0.1:${d.apiPort}${path}`, init);
}
async function createContextGraph(d: Daemon, cgId: string): Promise<void> {
  // Start with a local CG; the publish path may register it on-chain when the
  // VM job is processed. The separate staked core in startLiveKafkaTopology
  // supplies the real storage ACK, so this suite cannot pass through the old
  // fake same-node finalization path.
  const res = await authed(d, 'POST', '/api/context-graph/create', {
    id: cgId,
    name: cgId,
    register: false,
  });
  if (![200, 201, 409].includes(res.status)) {
    throw new Error(`createContextGraph failed: ${res.status} ${await res.text()}`);
  }
}
async function pollUntilFinalized(
  d: Daemon,
  basePath: string,
  captureID: string,
  // The real Hardhat publication normally crosses its confirmation boundary
  // just after 60 seconds. Leave enough headroom for a busy hosted runner
  // while staying below Vitest's 120-second per-test limit.
  timeoutMs = 90_000,
): Promise<{ state: string; ual: string | null; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const res = await authed(d, 'GET', `${basePath}/register/${encodeURIComponent(captureID)}`);
    if (res.status === 200) {
      last = await res.json();
      if (last.state === 'finalized' || last.state === 'completed' || last.state === 'failed') {
        return { state: last.state, ual: last.ual ?? null, error: last.error ?? null };
      }
    }
    await sleep(500);
  }
  throw new Error(`Poll timed out after ${timeoutMs}ms (last=${JSON.stringify(last)})`);
}
const BARE_CG = 'kafka-e2e-bare';
const EXT_CG = 'kafka-e2e-ext';
const BARE_BODY = {
  name: 'demo-stream',
  kafkaBootstrapUrl: 'kafka://broker:9092',
  kafkaTopicName: 'demo-topic',
};
const EXT_BODY = {
  ...BARE_BODY,
  externalRef: 'ref-alpha',
  sourceRef: 'source-001',
};
describe('kafka-plugin fixture setup', () => {
  it('builds the workspace kafka-plugin package before standalone fixtures', async () => {
    const calls: FixtureEntrypoint[] = [];
    await ensureKafkaPluginFixtures([], async (packageDir: string, entrypoint: string) => {
      calls.push({ packageDir, entrypoint });
    });
    expect(calls).toEqual([{ packageDir: KAFKA_PLUGIN_PACKAGE_DIR, entrypoint: KAFKA_PLUGIN_ENTRYPOINT }]);
  });
  it('builds missing fixture dist entrypoints before the E2E suite uses them', async () => {
    const fixtures: Array<FixtureEntrypoint & { tempRoot: string }> = [];
    try {
      fixtures.push(await copyFixtureWithoutDist(BARE_FIXTURE_DIR));
      fixtures.push(await copyFixtureWithoutDist(EXTENSION_FIXTURE_DIR));
      await ensureKafkaPluginFixtures(fixtures);
      for (const fixture of fixtures) {
        expect(existsSync(fixture.entrypoint)).toBe(true);
      }
    } finally {
      await Promise.all(fixtures.map((fixture) => rm(fixture.tempRoot, { recursive: true, force: true })));
    }
  }, 60_000);
  it('rebuilds fixture dist entrypoints when stale files already exist', async () => {
    const fixture = await copyFixtureWithoutDist(EXTENSION_FIXTURE_DIR);
    try {
      await mkdir(dirname(fixture.entrypoint), { recursive: true });
      await writeFile(fixture.entrypoint, 'export default { name: "stale-fixture", handle() {} };\n');
      await ensureKafkaPluginFixtures([fixture]);
      const built = await readFile(fixture.entrypoint, 'utf-8');
      expect(built).toContain('externalRef');
      expect(built).not.toContain('stale-fixture');
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
describe('pollUntilFinalized', () => {
  it('treats completed publisher jobs as successful terminal states', async () => {
    const ual = 'did:dkg:31337:0xabc/1/0';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ state: 'completed', ual }),
      { status: 200 },
    ));
    try {
      await expect(pollUntilFinalized({ apiPort: 1, token: 'test-token' } as Daemon, '/api/kafka/streams', 'capture', 10))
        .resolves.toEqual({ state: 'completed', ual, error: null });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
describe('StorageACK topology readiness', () => {
  const edge = { apiPort: 1, token: 'test-token', home: '/missing-kafka-edge-log' } as Daemon;
  const core = { apiPort: 2, token: 'test-token', home: '/missing-kafka-core-log' } as Daemon;
  const ready = {
    peerId: 'expected-core',
    connected: true,
    peerStore: { protocols: [PROTOCOL_STORAGE_ACK_V2] },
  };

  it('waits for the exact connected core to register V2 ACKs even when remote identify stays stale', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const [edgePeer, coreSelf] of [
      [ready, { ...ready, peerStore: { protocols: [] } }],
      [{ ...ready, peerId: 'different-core' }, ready],
      [ready, { ...ready, peerId: 'different-core' }],
      [{ ...ready, connected: false }, ready],
      [{ ...ready, peerStore: { protocols: [] } }, { ...ready, connected: false }],
    ]) {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(edgePeer), { status: 200 }));
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(coreSelf), { status: 200 }));
    }
    try {
      let settled = false;
      const pending = waitForStorageAckPeer(edge, core, ready.peerId).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 4; i++) {
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(250);
      }
      await pending;
      expect(fetchSpy).toHaveBeenCalledTimes(10);
      expect(fetchSpy).toHaveBeenLastCalledWith(
        'http://127.0.0.1:2/api/peer-info?peerId=expected-core',
        expect.objectContaining({ method: 'GET' }),
      );
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('bounds readiness and includes both daemon logs when ACK registration never completes', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ ...ready, peerStore: { protocols: [] } }), { status: 200 },
    ));
    try {
      const pending = waitForStorageAckPeer(edge, core, ready.peerId, 500).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(500);
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(`did not become ready for ${PROTOCOL_STORAGE_ACK_V2} within 500ms`);
      expect(String(error)).toContain('--- edge daemon log tail ---');
      expect(String(error)).toContain('--- core daemon log tail ---');
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['headers', 'body'] as const)('cancels stalled HTTP %s at the readiness deadline', async (stage) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      signal = init?.signal ?? undefined;
      if (stage === 'headers') {
        return new Promise<Response>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        });
      }
      return new Response(new ReadableStream({
        start(stream) {
          signal!.addEventListener('abort', () => stream.error(signal!.reason), { once: true });
        },
      }));
    });
    try {
      const pending = waitForStorageAckPeer(edge, core, ready.peerId, 500).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(500);
      const error = await pending;
      expect(signal?.aborted).toBe(true);
      expect(String(error)).toContain('StorageACK readiness deadline exceeded');
      expect(String(error)).toContain('--- edge daemon log tail ---');
      expect(String(error)).toContain('--- core daemon log tail ---');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('cancels the sibling diagnostics request when the other request fails', async () => {
    let siblingSignal: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('peer diagnostics unavailable'))
      .mockImplementationOnce(async (_url, init) => {
        siblingSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          siblingSignal!.addEventListener('abort', () => reject(siblingSignal!.reason), { once: true });
        });
      });
    try {
      const error = await waitForStorageAckPeer(edge, core, ready.peerId, 500).catch((error: unknown) => error);
      expect(String(error)).toContain('peer diagnostics unavailable');
      expect(siblingSignal?.aborted).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
describe('kafka-plugin live daemon E2E — bare baseline', () => {
  let core: Daemon | null = null;
  let daemon: Daemon | null = null;
  let bareUal: string | null = null;
  beforeAll(async () => {
    const topology = await startLiveKafkaTopology(BARE_FIXTURE, BARE_CG);
    core = topology.core;
    daemon = topology.edge;
    await createContextGraph(daemon, BARE_CG);
  }, 120_000);
  afterAll(async () => {
    await stopDaemon(daemon);
    await stopDaemon(core);
    daemon = null;
    core = null;
  }, 20_000);
  it('POST /api/kafka/streams/register accepts a stream registration with 202 + captureID', async () => {
    const res = await authed(daemon!, 'POST', '/api/kafka/streams/register', BARE_BODY);
    if (res.status !== 202) {
      const txt = await res.text();
      const log = await readFile(join(daemon!.home, 'daemon-stdio.log'), 'utf-8').catch(() => '<no log>');
      throw new Error(`POST register: ${res.status} ${txt}\n--- daemon log tail ---\n${log.split('\n').slice(-60).join('\n')}`);
    }
    const body = await res.json();
    expect(typeof body.captureID).toBe('string');
    expect(body.contextGraphId).toBe(BARE_CG);
    expect(typeof body.receivedAt).toBe('string');
    const final = await pollUntilFinalized(daemon!, '/api/kafka/streams', body.captureID);
    if (!['finalized', 'completed'].includes(final.state)) {
      throw new Error(
        `Expected finalized/completed; got ${final.state} error=${final.error}\n` +
        await topologyLogTails(daemon!, core!),
      );
    }
    expect(['finalized', 'completed']).toContain(final.state);
    expect(final.ual).toBeTruthy();
    expect(typeof final.ual).toBe('string');
    bareUal = final.ual;
  });
  it('GET /api/kafka/streams returns the private-default registered KA', async () => {
    expect(bareUal).toBeTruthy();
    const res = await authed(daemon!, 'GET', '/api/kafka/streams');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
    const found = body.items.find((it: any) => it['@id'] === bareUal);
    expect(found).toBeDefined();
    expect(found['@type']).toBe('dkg-streams:KafkaStream');
    expect(found['dkg-streams:kafkaBootstrapUrl']).toBe(BARE_BODY.kafkaBootstrapUrl);
    expect(found['dkg-streams:kafkaTopicName']).toBe(BARE_BODY.kafkaTopicName);
    expect(found['schema:name']).toBe(BARE_BODY.name);
    expect(found).not.toHaveProperty('dkg:privateDataAnchor');
  });
  it('GET /api/kafka/streams/:ual returns the same KA', async () => {
    expect(bareUal).toBeTruthy();
    const res = await authed(daemon!, 'GET', `/api/kafka/streams/${encodeURIComponent(bareUal!)}`);
    expect(res.status).toBe(200);
    const ka = await res.json();
    expect(ka['@id']).toBe(bareUal);
    expect(ka['@type']).toBe('dkg-streams:KafkaStream');
    expect(ka['dkg-streams:kafkaBootstrapUrl']).toBe(BARE_BODY.kafkaBootstrapUrl);
    expect(ka['dkg-streams:kafkaTopicName']).toBe(BARE_BODY.kafkaTopicName);
    expect(ka['schema:name']).toBe(BARE_BODY.name);
    expect(ka).not.toHaveProperty('dkg:privateDataAnchor');
  });
  it('POST with missing required field returns 400 InvalidContent', async () => {
    const res = await authed(daemon!, 'POST', '/api/kafka/streams/register', {
      kafkaBootstrapUrl: 'kafka://broker:9092',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('InvalidContent');
  });
  it('GET unknown captureID returns 404 CaptureNotFound', async () => {
    const res = await authed(daemon!, 'GET', '/api/kafka/streams/register/no-such-capture');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('CaptureNotFound');
  });
  it('GET unknown UAL returns 404 StreamNotFound', async () => {
    const res = await authed(daemon!, 'GET', '/api/kafka/streams/did:dkg:31337:0xdead/123/0');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('StreamNotFound');
  });
});
describe('kafka-plugin live daemon E2E — extension', () => {
  let core: Daemon | null = null;
  let daemon: Daemon | null = null;
  beforeAll(async () => {
    const topology = await startLiveKafkaTopology(EXTENSION_FIXTURE, EXT_CG);
    core = topology.core;
    daemon = topology.edge;
    await createContextGraph(daemon, EXT_CG);
  }, 120_000);
  afterAll(async () => {
    await stopDaemon(daemon);
    await stopDaemon(core);
    daemon = null;
    core = null;
  }, 20_000);
  it('POST with extension fields publishes a KA carrying both core + extension keys', async () => {
    const res = await authed(daemon!, 'POST', '/api/kafka/streams/register', EXT_BODY);
    if (res.status !== 202) {
      const txt = await res.text();
      const log = await readFile(join(daemon!.home, 'daemon-stdio.log'), 'utf-8').catch(() => '<no log>');
      throw new Error(`POST extension register: ${res.status} ${txt}\n--- daemon log tail ---\n${log.split('\n').slice(-60).join('\n')}`);
    }
    const body = await res.json();
    expect(typeof body.captureID).toBe('string');
    const final = await pollUntilFinalized(daemon!, '/api/kafka/streams', body.captureID);
    if (!['finalized', 'completed'].includes(final.state)) {
      throw new Error(
        `Expected extension publication to finalize; got ${final.state} error=${final.error}\n` +
        await topologyLogTails(daemon!, core!),
      );
    }
    expect(['finalized', 'completed']).toContain(final.state);
    expect(final.ual).toBeTruthy();
    const get = await authed(daemon!, 'GET', `/api/kafka/streams/${encodeURIComponent(final.ual!)}`);
    if (get.status !== 200) {
      throw new Error(
        `GET extension stream: ${get.status} ${await get.text()}\n` +
        await topologyLogTails(daemon!, core!),
      );
    }
    const ka = await get.json();
    expect(ka['@type']).toBe('dkg-streams:KafkaStream');
    expect(ka['@context']).toMatchObject({
      vendor: 'https://vendor.example.com/ontology#',
    });
    expect(ka['dkg-streams:kafkaBootstrapUrl']).toBe(EXT_BODY.kafkaBootstrapUrl);
    expect(ka['vendor:externalRef']).toBe(EXT_BODY.externalRef);
    expect(ka['vendor:sourceRef']).toBe(EXT_BODY.sourceRef);
  });
});
