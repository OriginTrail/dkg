import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import {
  ensureDkgNodeConfig,
  readPersistedHomeConfig,
  readPersistedNetworkConfigName,
  type EnsureDkgNodeConfigOptions,
} from '../src/ensure-dkg-node-config.js';
import { withFileLock } from '../src/file-lock.js';
import { homeConfigLockPath, type HomeConfigFile } from '../src/home-config-file.js';

// `dkgDir()` inside ensureDkgNodeConfig resolves via `resolveDkgConfigHome`,
// where an explicit `DKG_HOME` wins — so pointing it at a temp dir lets us
// assert the written config without touching the real `~/.dkg-dev`.
const NETWORK = { networkName: 'Test Net', defaultNodeRole: 'edge', defaultContextGraphs: [] as string[] };

describe('ensureDkgNodeConfig', () => {
  let tempHome: string;
  let jsonPath: string;
  let yamlPath: string;
  const originalEnv = process.env.DKG_HOME;

  beforeEach(() => {
    tempHome = join(tmpdir(), `dkg-ensure-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });
    jsonPath = join(tempHome, 'config.json');
    yamlPath = join(tempHome, 'config.yaml');
    process.env.DKG_HOME = tempHome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalEnv;
    rmSync(tempHome, { recursive: true, force: true });
  });

  const readWritten = (): Record<string, any> => JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const writeExisting = (config: Record<string, unknown>): void => {
    writeFileSync(jsonPath, JSON.stringify(config) + '\n');
  };
  const runSetup = (options: Partial<EnsureDkgNodeConfigOptions> = {}) => ensureDkgNodeConfig({
    agentName: 'node-a',
    network: NETWORK,
    networkConfigName: 'testnet',
    apiPort: 9200,
    ...options,
  });

  /**
   * Hold the config lock the way a daemon or CLI write does, start setup
   * while it is held, and let `whileHeld` change the config before setup
   * gets the lock.
   */
  async function runSetupWhileLockHeld(whileHeld: () => void) {
    let pending: ReturnType<typeof runSetup> | undefined;
    await withFileLock(homeConfigLockPath(tempHome), async () => {
      pending = runSetup();
      // Let setup reach the lock and start waiting for it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      whileHeld();
    });
    return pending!;
  }

  describe('store-backend default (issue #960)', () => {
    it('seeds the oxigraph-server default on a fresh install with no explicit store', async () => {
      await runSetup();
      expect(readWritten().store).toEqual({ backend: 'oxigraph-server' });
    });

    it('does NOT flip an existing (block-less) node onto a new backend', async () => {
      // Simulate an existing node: a config.json is already on disk (it had been
      // running on the oxigraph-worker runtime fallback). Re-running setup must
      // not silently switch its backend (which would force a store reset).
      writeExisting({ name: 'node-a', nodeRole: 'edge' });
      await runSetup();
      expect(readWritten().store).toBeUndefined();
    });

    it('preserves an explicit existing store block', async () => {
      const store = { backend: 'blazegraph', options: { url: 'http://localhost:9999/blazegraph' } };
      writeExisting({ store });
      await runSetup();
      expect(readWritten().store).toEqual(store);
    });

    it('counts a config created while setup waited for the lock as existing', async () => {
      // "Fresh" is decided under the lock: a config the daemon or CLI wrote
      // while setup waited must not be seeded onto a new backend.
      const result = await runSetupWhileLockHeld(() => writeExisting({ name: 'other-writer', nodeRole: 'core' }));

      expect(result.changed).toBe(true);
      expect(readWritten().store).toBeUndefined();
      expect(readWritten()).toMatchObject({ name: 'other-writer', nodeRole: 'core', networkConfig: 'testnet' });
    });
  });

  it('persists the selected network as config.networkConfig', async () => {
    await runSetup({ networkConfigName: 'mainnet-gnosis' });
    expect(readWritten().networkConfig).toBe('mainnet-gnosis');
  });

  it('rewrites networkConfig to the selected value even when one already exists', async () => {
    writeExisting({ name: 'node-a', nodeRole: 'edge', networkConfig: 'testnet' });
    await runSetup({ networkConfigName: 'mainnet-base' });
    expect(readWritten().networkConfig).toBe('mainnet-base');
  });

  it('exposes KA publish lifecycle debug logging in fresh config and defaults it off', async () => {
    await runSetup();
    expect(readWritten().logging).toEqual({ kaPublishLifecycleDebug: false });
  });

  it('preserves an explicit KA publish lifecycle debug logging config', async () => {
    writeExisting({ logging: { kaPublishLifecycleDebug: true } });
    await runSetup();
    expect(readWritten().logging).toEqual({ kaPublishLifecycleDebug: true });
  });

  it('writes a fresh config with the same keys, order and formatting as before', async () => {
    await runSetup({ network: { ...NETWORK, defaultContextGraphs: ['cg-a'], autoUpdate: { enabled: true, branch: 'main' } } });

    expect(readFileSync(jsonPath, 'utf-8')).toBe(`${JSON.stringify({
      name: 'node-a',
      networkConfig: 'testnet',
      apiPort: 9200,
      nodeRole: 'edge',
      contextGraphs: ['cg-a'],
      auth: { enabled: true },
      logging: { kaPublishLifecycleDebug: false },
      autoUpdate: { enabled: true },
      store: { backend: 'oxigraph-server' },
    }, null, 2)}\n`);
  });

  it('keeps existing values over defaults, and explicit --name/--port over both', async () => {
    const existing = {
      name: 'persisted',
      apiPort: 9300,
      nodeRole: 'core',
      contextGraphs: ['mine'],
      auth: { enabled: false },
      relay: '/ip4/5.6.7.8/tcp/9090/p2p/existing',
      autoUpdate: { enabled: false },
    };
    writeExisting(existing);
    await runSetup({ network: { ...NETWORK, autoUpdate: { enabled: true } } });
    expect(readWritten()).toMatchObject(existing);

    await runSetup({ agentName: 'renamed', apiPort: 9400, overrides: { nameExplicit: true, portExplicit: true } });
    expect(readWritten()).toMatchObject({ ...existing, name: 'renamed', apiPort: 9400 });
  });

  it('keeps a daemon edit made while setup waited for the config lock', async () => {
    writeExisting({ name: 'node-a', apiPort: 9300 });

    await runSetupWhileLockHeld(() => {
      // The daemon's own patch (e.g. an LLM setting saved in the node UI),
      // landing after setup started but before it could take the lock.
      writeExisting({ ...readWritten(), llm: { model: 'set-by-daemon' } });
    });

    expect(readWritten()).toMatchObject({
      name: 'node-a',
      apiPort: 9300,
      networkConfig: 'testnet',
      auth: { enabled: true },
      llm: { model: 'set-by-daemon' },
    });
  });

  it('keeps a YAML-only node in YAML and never writes a shadowing config.json', async () => {
    // loadConfig / resolveDkgConfigHome accept config.yaml as a valid config, so
    // a YAML-only node is patched in place — and, being an existing node, is
    // not seeded with a store backend.
    writeFileSync(yamlPath, 'name: yaml-node\napiPort: 9317\nnodeRole: core\nchain:\n  rpcUrl: https://private.rpc\n');

    const result = await runSetup({ networkConfigName: 'mainnet-gnosis' });

    expect(existsSync(jsonPath)).toBe(false);
    expect(result.path).toBe(yamlPath);
    expect(yaml.load(readFileSync(yamlPath, 'utf-8'))).toEqual({
      name: 'yaml-node',
      apiPort: 9317,
      nodeRole: 'core',
      chain: { rpcUrl: 'https://private.rpc' },
      networkConfig: 'mainnet-gnosis',
      contextGraphs: [],
      auth: { enabled: true },
      logging: { kaPublishLifecycleDebug: false },
    });
  });

  it('keeps the permission bits of the config file', async () => {
    writeExisting({ name: 'node-a' });
    chmodSync(jsonPath, 0o600);

    await runSetup();

    expect(readWritten().networkConfig).toBe('testnet');
    // Windows keeps only a read-only flag, not POSIX permission bits.
    if (process.platform !== 'win32') expect(statSync(jsonPath).mode & 0o777).toBe(0o600);
  });

  it('returns the persisted config so callers can read back the effective name and port', async () => {
    writeExisting({ name: 'persisted', apiPort: 9300 });

    const result = await runSetup();

    expect(result).toMatchObject({ path: jsonPath, changed: true, config: { name: 'persisted', apiPort: 9300 } });
  });

  it('writes nothing when the config already matches, and says so', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSetup();
    const first = readFileSync(jsonPath, 'utf-8');
    const firstMtime = statSync(jsonPath).mtimeMs;

    const rerun = await runSetup();

    expect(rerun.changed).toBe(false);
    expect(readFileSync(jsonPath, 'utf-8')).toBe(first);
    expect(statSync(jsonPath).mtimeMs).toBe(firstMtime);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      `[setup] Wrote ${jsonPath} (Test Net, edge, port 9200)`,
      `[setup] ${jsonPath} is already up to date (Test Net, edge, port 9200)`,
    ]);
  });

  it('runs migrateExisting on the re-read file before the field-level merge', async () => {
    writeExisting({ name: 'node-a', legacyAdapterFlag: true, autoUpdate: { enabled: true, branch: 'main' } });
    const seen: HomeConfigFile[] = [];

    await runSetup({
      network: { ...NETWORK, autoUpdate: { enabled: false } },
      migrateExisting: (existing, file) => {
        seen.push(file);
        delete existing.legacyAdapterFlag;
        delete existing.autoUpdate;
      },
    });

    expect(seen).toEqual([{ path: jsonPath, format: 'json', existed: true }]);
    const written = readWritten();
    expect(written.legacyAdapterFlag).toBeUndefined();
    // The merge saw the migrated object: with autoUpdate gone, it mirrors the
    // network's `enabled` flag.
    expect(written.autoUpdate).toEqual({ enabled: false });
  });

  it('refuses a config.json it cannot parse and leaves it as it is', async () => {
    writeFileSync(jsonPath, '{ not json');

    await expect(runSetup()).rejects.toThrow(`${jsonPath} is not valid JSON`);

    expect(readFileSync(jsonPath, 'utf-8')).toBe('{ not json');
  });
});

describe('readPersistedNetworkConfigName — JSON + YAML aware', () => {
  let tempHome: string;
  beforeEach(() => {
    tempHome = join(tmpdir(), `dkg-read-net-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });
  });
  afterEach(() => rmSync(tempHome, { recursive: true, force: true }));

  it('returns undefined when no config exists', () => {
    expect(readPersistedNetworkConfigName(tempHome)).toBeUndefined();
  });

  it('reads networkConfig from config.json', () => {
    writeFileSync(join(tempHome, 'config.json'), JSON.stringify({ networkConfig: 'mainnet-base' }));
    expect(readPersistedNetworkConfigName(tempHome)).toBe('mainnet-base');
  });

  it('reads networkConfig from a YAML-only node (the gap the review caught)', () => {
    writeFileSync(join(tempHome, 'config.yaml'), 'name: n\nnetworkConfig: mainnet-gnosis\n');
    expect(readPersistedNetworkConfigName(tempHome)).toBe('mainnet-gnosis');
  });

  it('prefers config.json over config.yaml when both exist', () => {
    writeFileSync(join(tempHome, 'config.json'), JSON.stringify({ networkConfig: 'testnet' }));
    writeFileSync(join(tempHome, 'config.yaml'), 'networkConfig: mainnet-base\n');
    expect(readPersistedNetworkConfigName(tempHome)).toBe('testnet');
  });

  it('returns undefined for an existing config that does not set networkConfig', () => {
    writeFileSync(join(tempHome, 'config.json'), JSON.stringify({ name: 'n', nodeRole: 'edge' }));
    expect(readPersistedNetworkConfigName(tempHome)).toBeUndefined();
  });

  it('reads the whole config and names the file it came from', () => {
    expect(readPersistedHomeConfig(tempHome)).toBeUndefined();

    writeFileSync(join(tempHome, 'config.yaml'), 'name: yaml-node\napiPort: 9317\n');
    expect(readPersistedHomeConfig(tempHome)).toEqual({
      path: join(tempHome, 'config.yaml'),
      config: { name: 'yaml-node', apiPort: 9317 },
    });

    // A corrupt config.json falls through to config.yaml (best-effort).
    writeFileSync(join(tempHome, 'config.json'), '{ not json');
    expect(readPersistedHomeConfig(tempHome)?.path).toBe(join(tempHome, 'config.yaml'));

    writeFileSync(join(tempHome, 'config.json'), JSON.stringify({ name: 'json-node' }));
    expect(readPersistedHomeConfig(tempHome)).toEqual({
      path: join(tempHome, 'config.json'),
      config: { name: 'json-node' },
    });
  });

  it('returns undefined when the only config is corrupt or not an object', () => {
    writeFileSync(join(tempHome, 'config.yaml'), 'name: [unclosed\n');
    expect(readPersistedHomeConfig(tempHome)).toBeUndefined();

    writeFileSync(join(tempHome, 'config.yaml'), 'just-a-string\n');
    expect(readPersistedHomeConfig(tempHome)).toBeUndefined();
  });
});
