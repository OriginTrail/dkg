/** kafka-plugin live-daemon E2E. Mirrors packages/cli/test/daemon/plugin-routes-api.e2e.test.ts. */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { getSharedContext } from '../../chain/test/evm-test-context.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
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
interface Daemon {
  home: string;
  apiPort: number;
  listenPort: number;
  child: ChildProcess;
  token: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}
const API_PORT_BASE = 22000;
const LISTEN_PORT_BASE = 23000;
function uniquePort(base: number): number {
  return base + Math.floor(Math.random() * 1000);
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
  pluginPath: string;
  cgId: string;
}
async function writeDaemonConfig(
  home: string,
  apiPort: number,
  listenPort: number,
  opts: DaemonOpts,
): Promise<void> {
  const { rpcUrl, hubAddress } = getSharedContext();
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      name: 'kafka-plugin-e2e',
      apiPort,
      listenPort,
      apiHost: '127.0.0.1',
      nodeRole: 'edge',
      relay: 'none',
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
      publisher: { enabled: true },
      sharedMemoryPublicSnapshotStorage: { enabled: false },
      kafka: { contextGraphId: opts.cgId },
      routePlugins: [opts.pluginPath],
    }),
  );
  const walletEntry = JSON.stringify({
    wallets: [{ address: CORE_OP_ADDRESS, privateKey: HARDHAT_KEYS.CORE_OP }],
  }, null, 2) + '\n';
  await writeFile(join(home, 'wallets.json'), walletEntry, { mode: 0o600 });
  await writeFile(join(home, 'publisher-wallets.json'), walletEntry, { mode: 0o600 });
}
async function startDaemon(opts: DaemonOpts): Promise<Daemon> {
  await ensureKafkaPluginFixtures();
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `CLI not built at ${CLI_ENTRY}. Run \`pnpm --filter @origintrail-official/dkg build\` first.`,
    );
  }
  await ensureFixtureEntrypoint(dirname(dirname(opts.pluginPath)), opts.pluginPath);
  const home = await mkdtemp(join(tmpdir(), 'dkg-kafka-plugin-e2e-'));
  const apiPort = uniquePort(API_PORT_BASE);
  const listenPort = uniquePort(LISTEN_PORT_BASE);
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
  const daemon: Daemon = { home, apiPort, listenPort, child, token: '' };
  child.once('exit', (code, signal) => {
    daemon.exitCode = code;
    daemon.signal = signal;
  });
  try {
    for (let i = 0; i < 90; i++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Daemon exited early (code=${child.exitCode}, signal=${child.signalCode}).\n--- daemon stdio tail ---\n${await tail()}`,
        );
      }
      try {
        const res = await fetch(`http://127.0.0.1:${apiPort}/api/status`);
        if (res.ok) break;
      } catch { /* not ready yet */ }
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
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${d.token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(`http://127.0.0.1:${d.apiPort}${path}`, init);
}
async function createContextGraph(d: Daemon, cgId: string): Promise<void> {
  // GH #1013 — the e2e CG is deliberately LOCAL-ONLY (no on-chain
  // registration). The kafka plugin registers streams as fully-PRIVATE KAs
  // (`{ private: ka }`), and this harness is a single isolated daemon: a
  // chain-registered CG can never collect the private-payload storage ACKs
  // quorum here, so the async publish now fails HONESTLY (the old run only
  // reached `finalized` through the fake local-finalization #1013 removed).
  // A chainless CG finalizes locally as a legitimate, honest terminal state,
  // which keeps this suite covering the full register→list→get pipeline.
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
  timeoutMs = 60_000,
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
describe('kafka-plugin live daemon E2E — bare baseline', () => {
  let daemon: Daemon | null = null;
  let bareUal: string | null = null;
  beforeAll(async () => {
    daemon = await startDaemon({ pluginPath: BARE_FIXTURE, cgId: BARE_CG });
    await createContextGraph(daemon, BARE_CG);
  }, 90_000);
  afterAll(async () => {
    await stopDaemon(daemon);
    daemon = null;
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
      const log = await readFile(join(daemon!.home, 'daemon-stdio.log'), 'utf-8').catch(() => '<no log>');
      throw new Error(`Expected finalized/completed; got ${final.state} error=${final.error}\n--- daemon log tail ---\n${log.split('\n').slice(-80).join('\n')}`);
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
  let daemon: Daemon | null = null;
  beforeAll(async () => {
    daemon = await startDaemon({ pluginPath: EXTENSION_FIXTURE, cgId: EXT_CG });
    await createContextGraph(daemon, EXT_CG);
  }, 90_000);
  afterAll(async () => {
    await stopDaemon(daemon);
    daemon = null;
  }, 20_000);
  it('POST with extension fields publishes a KA carrying both core + extension keys', async () => {
    const res = await authed(daemon!, 'POST', '/api/kafka/streams/register', EXT_BODY);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(typeof body.captureID).toBe('string');
    const final = await pollUntilFinalized(daemon!, '/api/kafka/streams', body.captureID);
    expect(['finalized', 'completed']).toContain(final.state);
    expect(final.ual).toBeTruthy();
    const get = await authed(daemon!, 'GET', `/api/kafka/streams/${encodeURIComponent(final.ual!)}`);
    expect(get.status).toBe(200);
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
